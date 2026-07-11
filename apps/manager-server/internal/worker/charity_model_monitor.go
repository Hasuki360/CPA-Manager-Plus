package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/cpa"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
)

const (
	charityMonitorUserAgent            = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
	charityMonitorCodexVersionFallback = "0.142.5"
	charityMonitorCodexNpmLatestURL    = "https://registry.npmjs.org/@openai%2Fcodex/latest"
	charityMonitorCodexVersionTTL      = 6 * time.Hour
	charityMonitorDisableAllModelsRule = "*"
)

type CharityModelMonitorConfig struct {
	Enabled         bool
	IntervalMinutes int
	Sites           []model.CharityModelMonitorSite
	CPAUpstreamURL  string
	ManagementKey   string
}

type CharityModelMonitorWorker struct {
	store  *store.Store
	client *http.Client

	mu     sync.RWMutex
	config CharityModelMonitorConfig
}

type charityProviderEntry struct {
	Entry        map[string]any
	CustomModels []string
}

func NewCharityModelMonitorWorker(st *store.Store, cfg CharityModelMonitorConfig) *CharityModelMonitorWorker {
	return &CharityModelMonitorWorker{
		store: st,
		client: &http.Client{Timeout: 40 * time.Second},
		config: normalizeCharityMonitorConfig(cfg),
	}
}

func (w *CharityModelMonitorWorker) Start(ctx context.Context) {
	if w == nil {
		return
	}
	go w.loop(ctx)
}

func (w *CharityModelMonitorWorker) UpdateConfig(ctx context.Context, cfg CharityModelMonitorConfig) {
	if w == nil {
		return
	}
	w.mu.Lock()
	w.config = normalizeCharityMonitorConfig(cfg)
	w.mu.Unlock()
	if w.snapshot().Enabled {
		go w.runOnce(ctx)
	}
}

func (w *CharityModelMonitorWorker) loop(ctx context.Context) {
	w.runOnce(ctx)
	for {
		interval := time.Duration(w.snapshot().IntervalMinutes) * time.Minute
		if interval <= 0 {
			interval = time.Duration(model.DefaultCharityModelMonitorIntervalMinutes) * time.Minute
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
			w.runOnce(ctx)
		}
	}
}

func (w *CharityModelMonitorWorker) runOnce(ctx context.Context) {
	cfg := w.snapshot()
	if !cfg.Enabled {
		return
	}
	if strings.TrimSpace(cfg.CPAUpstreamURL) == "" || strings.TrimSpace(cfg.ManagementKey) == "" {
		log.Printf("[charity-model-monitor] skipped: CPA upstream or management key is not configured")
		return
	}
	state, ok, err := w.store.LoadCharityModelMonitorState(ctx)
	if err != nil {
		log.Printf("[charity-model-monitor] load state: %v", err)
		return
	}
	if !ok || state.Sites == nil {
		state.Sites = map[string]model.CharityModelMonitorSiteState{}
	}
	state.LastCheck = time.Now().Format(time.RFC3339)
	state.LastProviderError = nil

	codexVersion := w.codexVersion(ctx, &state)
	providerResults := make([]model.CharityModelMonitorProviderState, 0)
	totalModels := 0
	seen := map[string]struct{}{}
	for _, site := range cfg.Sites {
		if !site.Enabled {
			continue
		}
		siteState, results, err := w.checkSite(ctx, cfg, site, codexVersion)
		if err != nil {
			msg := fmt.Sprintf("%s: %v", site.Name, err)
			state.LastProviderError = append(state.LastProviderError, msg)
			log.Printf("[charity-model-monitor] %s", msg)
			continue
		}
		state.Sites[site.Key] = siteState
		totalModels += siteState.LastTotalModels
		for _, name := range siteState.LastTargetModels {
			seen[name] = struct{}{}
		}
		providerResults = append(providerResults, results...)
	}
	state.LastTotalModels = totalModels
	state.Seen = sortedKeys(seen)
	state.LastProviderSync = providerResults
	if _, err := w.store.SaveCharityModelMonitorState(ctx, state); err != nil {
		log.Printf("[charity-model-monitor] save state: %v", err)
	}
}

func (w *CharityModelMonitorWorker) checkSite(ctx context.Context, cfg CharityModelMonitorConfig, site model.CharityModelMonitorSite, codexVersion string) (model.CharityModelMonitorSiteState, []model.CharityModelMonitorProviderState, error) {
	var targets []string
	var gptModels []string
	var claudeModels []string
	if !site.SyncCodexHeadersOnly {
		pricing, err := w.fetchPricing(ctx, site)
		if err != nil {
			return model.CharityModelMonitorSiteState{}, nil, err
		}
		targets, gptModels, claudeModels = extractCharityModels(pricing)
	}
	state := model.CharityModelMonitorSiteState{
		Name:             site.Name,
		LastTotalModels:  len(targets),
		LastTargetModels: targets,
		LastGPTModels:    gptModels,
		LastClaudeModels: claudeModels,
	}
	configData, err := w.cpaRequest(ctx, cfg, http.MethodGet, "/config", nil)
	if err != nil {
		return state, nil, err
	}
	results := make([]model.CharityModelMonitorProviderState, 0, 2)
	if site.CodexBaseURL != "" && (site.MonitorGPT || site.SyncCodexHeadersOnly) {
		result, err := w.syncProvider(ctx, cfg, configData, site, "Codex", site.CodexProviderSection, site.CodexBaseURL, gptModels, codexProviderHeaders(codexVersion), site.SyncCodexHeadersOnly)
		if err != nil {
			return state, results, err
		}
		results = append(results, result)
	}
	if site.ClaudeBaseURL != "" && site.MonitorClaude && !site.SyncCodexHeadersOnly {
		result, err := w.syncProvider(ctx, cfg, configData, site, "Claude", site.ClaudeProviderSection, site.ClaudeBaseURL, claudeModels, nil, false)
		if err != nil {
			return state, results, err
		}
		results = append(results, result)
	}
	return state, results, nil
}

func (w *CharityModelMonitorWorker) snapshot() CharityModelMonitorConfig {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return normalizeCharityMonitorConfig(w.config)
}

func normalizeCharityMonitorConfig(cfg CharityModelMonitorConfig) CharityModelMonitorConfig {
	cfg.IntervalMinutes = model.NormalizeCharityModelMonitorInterval(cfg.IntervalMinutes)
	cfg.Sites = model.NormalizeCharityModelMonitorSites(cfg.Sites)
	cfg.CPAUpstreamURL = strings.TrimSpace(cfg.CPAUpstreamURL)
	cfg.ManagementKey = strings.TrimSpace(cfg.ManagementKey)
	return cfg
}

func (w *CharityModelMonitorWorker) fetchPricing(ctx context.Context, site model.CharityModelMonitorSite) (map[string]any, error) {
	pricingURL := strings.TrimSpace(site.PricingURL)
	if pricingURL == "" {
		return nil, errors.New("pricing URL is empty")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, pricingURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", charityMonitorUserAgent)
	req.Header.Set("Accept", "application/json, text/plain, */*")
	if referer := strings.TrimSpace(site.Referer); referer != "" {
		req.Header.Set("Referer", referer)
	}
	res, err := w.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("pricing request failed: %s", res.Status)
	}
	var data map[string]any
	if err := json.NewDecoder(res.Body).Decode(&data); err != nil {
		return nil, err
	}
	return data, nil
}

func extractCharityModels(data map[string]any) ([]string, []string, []string) {
	items, _ := data["data"].([]any)
	targets := map[string]struct{}{}
	gpt := map[string]struct{}{}
	claude := map[string]struct{}{}
	for _, item := range items {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name := strings.TrimSpace(fmt.Sprint(row["model_name"]))
		lower := strings.ToLower(name)
		if name == "" || strings.Contains(lower, "image") {
			continue
		}
		switch {
		case strings.HasPrefix(lower, "gpt-"):
			targets[name] = struct{}{}
			gpt[name] = struct{}{}
		case strings.HasPrefix(lower, "claude-"):
			targets[name] = struct{}{}
			claude[name] = struct{}{}
		}
	}
	return sortedKeys(targets), sortedKeys(gpt), sortedKeys(claude)
}

func sortedKeys(values map[string]struct{}) []string {
	result := make([]string, 0, len(values))
	for value := range values {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func providerCustomModels(entry map[string]any) []string {
	modelsRaw, ok := entry["models"]
	if !ok || modelsRaw == nil {
		return nil
	}
	seen := map[string]struct{}{}
	add := func(value string) {
		value = strings.TrimSpace(value)
		if value == "" {
			return
		}
		seen[value] = struct{}{}
	}
	switch typed := modelsRaw.(type) {
	case []any:
		for _, item := range typed {
			switch row := item.(type) {
			case map[string]any:
				add(fmt.Sprint(row["name"]))
			case string:
				add(row)
			}
		}
	case []map[string]any:
		for _, row := range typed {
			add(fmt.Sprint(row["name"]))
		}
	case []string:
		for _, item := range typed {
			add(item)
		}
	}
	return sortedKeys(seen)
}

func mergeCustomModels(entries []charityProviderEntry) []string {
	seen := map[string]struct{}{}
	for _, entry := range entries {
		for _, modelName := range entry.CustomModels {
			if strings.TrimSpace(modelName) != "" {
				seen[modelName] = struct{}{}
			}
		}
	}
	return sortedKeys(seen)
}

func intersectModels(wanted []string, available []string) []string {
	availableSet := map[string]string{}
	for _, modelName := range available {
		key := strings.ToLower(strings.TrimSpace(modelName))
		if key != "" {
			availableSet[key] = modelName
		}
	}
	matched := map[string]struct{}{}
	for _, modelName := range wanted {
		key := strings.ToLower(strings.TrimSpace(modelName))
		if actual, ok := availableSet[key]; ok {
			matched[actual] = struct{}{}
		}
	}
	return sortedKeys(matched)
}

func (w *CharityModelMonitorWorker) syncProvider(ctx context.Context, cfg CharityModelMonitorConfig, configData map[string]any, site model.CharityModelMonitorSite, label string, section string, baseURL string, availableModels []string, desiredHeaders map[string]string, preserveSwitch bool) (model.CharityModelMonitorProviderState, error) {
	section = strings.TrimSpace(section)
	baseURL = strings.TrimSpace(baseURL)
	if section == "" || baseURL == "" {
		return model.CharityModelMonitorProviderState{}, errors.New("provider section or base URL is empty")
	}
	entries, ok := configData[section].([]any)
	if !ok {
		return model.CharityModelMonitorProviderState{}, fmt.Errorf("CPA config section %q is not a list", section)
	}
	matched := make([]charityProviderEntry, 0)
	for _, item := range entries {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if normalizeURL(fmt.Sprint(entry["base-url"])) == normalizeURL(baseURL) {
			matched = append(matched, charityProviderEntry{
				Entry:        entry,
				CustomModels: providerCustomModels(entry),
			})
		}
	}
	if len(matched) == 0 {
		return model.CharityModelMonitorProviderState{}, fmt.Errorf("CPA config provider not found: %s %s", section, baseURL)
	}
	checkMode := "pattern"
	customModels := mergeCustomModels(matched)
	matchedModels := availableModels
	enable := len(availableModels) > 0
	if len(customModels) > 0 {
		checkMode = "custom"
		matchedModels = intersectModels(customModels, availableModels)
		enable = len(matchedModels) > 0
	}
	desiredDisabled := !enable
	if preserveSwitch {
		desiredDisabled = isDisabledByExcludedModels(matched[0].Entry)
		matchedModels = nil
	}
	switchChanged := false
	headersChanged := false
	for _, matchedEntry := range matched {
		entry := matchedEntry.Entry
		if !preserveSwitch {
			switchChanged = setDisabledByExcludedModels(entry, desiredDisabled) || switchChanged
		}
		headersChanged = syncProviderHeaders(entry, desiredHeaders) || headersChanged
		delete(entry, "auth-index")
	}
	changed := switchChanged || headersChanged
	if changed {
		if _, err := w.cpaRequest(ctx, cfg, http.MethodPut, "/"+section, entries); err != nil {
			return model.CharityModelMonitorProviderState{}, err
		}
	}
	reason := "pattern matched"
	if checkMode == "custom" {
		if enable {
			reason = "custom model matched"
		} else {
			reason = "all custom models missing"
		}
	} else if !enable && !preserveSwitch {
		reason = "no matching model"
	} else if preserveSwitch {
		reason = "headers only"
	}
	return model.CharityModelMonitorProviderState{
		Site:           site.Name,
		Label:          label,
		Section:        section,
		Provider:       baseURL,
		DesiredEnabled: !desiredDisabled,
		Changed:        changed,
		SwitchChanged:  switchChanged,
		HeadersChanged: headersChanged,
		DesiredHeaders: desiredHeaders,
		CheckMode:      checkMode,
		CustomModels:   customModels,
		MatchedModels:  matchedModels,
		Reason:         reason,
	}, nil
}

func (w *CharityModelMonitorWorker) cpaRequest(ctx context.Context, cfg CharityModelMonitorConfig, method string, path string, payload any) (map[string]any, error) {
	baseURL := cpa.NormalizeBaseURL(cfg.CPAUpstreamURL) + "/v0/management"
	endpoint := baseURL + path
	var body *bytes.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		body = bytes.NewReader(data)
	} else {
		body = bytes.NewReader(nil)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.ManagementKey)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", charityMonitorUserAgent)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := w.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("CPA management %s %s failed: %s", method, path, res.Status)
	}
	if res.ContentLength == 0 {
		return map[string]any{}, nil
	}
	var data map[string]any
	if err := json.NewDecoder(res.Body).Decode(&data); err != nil {
		if errors.Is(err, context.Canceled) {
			return nil, err
		}
		return map[string]any{}, nil
	}
	return data, nil
}

func isDisabledByExcludedModels(entry map[string]any) bool {
	for _, item := range excludedModels(entry["excluded-models"]) {
		if item == charityMonitorDisableAllModelsRule {
			return true
		}
	}
	return false
}

func setDisabledByExcludedModels(entry map[string]any, disabled bool) bool {
	current := excludedModels(entry["excluded-models"])
	before := strings.Join(current, "\x00")
	if disabled {
		if !containsString(current, charityMonitorDisableAllModelsRule) {
			current = append(current, charityMonitorDisableAllModelsRule)
		}
	} else {
		filtered := current[:0]
		for _, value := range current {
			if value != charityMonitorDisableAllModelsRule {
				filtered = append(filtered, value)
			}
		}
		current = filtered
	}
	if len(current) == 0 {
		delete(entry, "excluded-models")
	} else {
		entry["excluded-models"] = current
	}
	return before != strings.Join(current, "\x00")
}

func excludedModels(value any) []string {
	switch typed := value.(type) {
	case []any:
		result := make([]string, 0, len(typed))
		for _, item := range typed {
			if text := strings.TrimSpace(fmt.Sprint(item)); text != "" {
				result = append(result, text)
			}
		}
		return result
	case []string:
		result := make([]string, 0, len(typed))
		for _, item := range typed {
			if text := strings.TrimSpace(item); text != "" {
				result = append(result, text)
			}
		}
		return result
	case string:
		parts := strings.Split(typed, ",")
		result := make([]string, 0, len(parts))
		for _, part := range parts {
			if text := strings.TrimSpace(part); text != "" {
				result = append(result, text)
			}
		}
		return result
	default:
		return nil
	}
}

func syncProviderHeaders(entry map[string]any, desired map[string]string) bool {
	if len(desired) == 0 {
		return false
	}
	current := map[string]any{}
	if raw, ok := entry["headers"].(map[string]any); ok {
		for key, value := range raw {
			current[key] = value
		}
	}
	before, _ := json.Marshal(current)
	for key, value := range desired {
		current[key] = value
	}
	entry["headers"] = current
	after, _ := json.Marshal(current)
	return !bytes.Equal(before, after)
}

func containsString(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

func normalizeURL(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return ""
	}
	parsed, err := url.Parse(value)
	if err == nil && parsed.Scheme != "" {
		parsed.Path = strings.TrimRight(parsed.Path, "/")
		return strings.ToLower(strings.TrimRight(parsed.String(), "/"))
	}
	return strings.ToLower(strings.TrimRight(value, "/"))
}

func codexProviderHeaders(version string) map[string]string {
	version = strings.TrimSpace(version)
	if version == "" {
		version = charityMonitorCodexVersionFallback
	}
	return map[string]string{
		"User-Agent":        fmt.Sprintf("codex_cli_rs/%s (Mac OS 26.6.0; arm64)", version),
		"originator":        "codex_cli_rs",
		"x-openai-subagent": "codex-mcp-client",
	}
}

func (w *CharityModelMonitorWorker) codexVersion(ctx context.Context, state *model.CharityModelMonitorState) string {
	now := time.Now()
	if state != nil && state.LastCodexCLIVersion != "" && state.LastCodexVersionChecked > 0 {
		checked := time.UnixMilli(state.LastCodexVersionChecked)
		if now.Sub(checked) < charityMonitorCodexVersionTTL {
			return state.LastCodexCLIVersion
		}
	}
	version, err := w.fetchCodexVersion(ctx)
	if err != nil || version == "" {
		if state != nil && state.LastCodexCLIVersion != "" {
			return state.LastCodexCLIVersion
		}
		return charityMonitorCodexVersionFallback
	}
	if state != nil {
		state.LastCodexCLIVersion = version
		state.LastCodexVersionChecked = now.UnixMilli()
	}
	return version
}

func (w *CharityModelMonitorWorker) fetchCodexVersion(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, charityMonitorCodexNpmLatestURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", charityMonitorUserAgent)
	req.Header.Set("Accept", "application/json")
	res, err := w.client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", fmt.Errorf("codex version request failed: %s", res.Status)
	}
	var data struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(res.Body).Decode(&data); err != nil {
		return "", err
	}
	return strings.TrimSpace(data.Version), nil
}
