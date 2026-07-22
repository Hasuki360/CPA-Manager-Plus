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
		store:  st,
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
	checkedAt := time.Now().Format(time.RFC3339)
	state.LastCheck = checkedAt
	state.LastProviderError = nil

	codexVersion := w.codexVersion(ctx, &state)
	providerResults := make([]model.CharityModelMonitorProviderState, 0)
	totalModels := 0
	seen := map[string]struct{}{}
	log.Printf("[charity-model-monitor] cycle start at=%s interval=%dm sites=%d codexCli=%s",
		checkedAt, cfg.IntervalMinutes, len(cfg.Sites), codexVersion)
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
		for i := range results {
			results[i].CheckedAt = checkedAt
			logCharityProviderDecision(results[i])
		}
		providerResults = append(providerResults, results...)
	}
	state.LastTotalModels = totalModels
	state.Seen = sortedKeys(seen)
	state.LastProviderSync = providerResults
	state.History = appendCharityHistory(state.History, model.CharityModelMonitorHistoryEntry{
		CheckedAt:       checkedAt,
		CodexCLIVersion: codexVersion,
		TotalModels:     totalModels,
		ProviderResults: cloneProviderResults(providerResults),
		ProviderErrors:  append([]string(nil), state.LastProviderError...),
	})
	log.Printf("[charity-model-monitor] cycle done at=%s providers=%d errors=%d history=%d",
		checkedAt, len(providerResults), len(state.LastProviderError), len(state.History))
	if _, err := w.store.SaveCharityModelMonitorState(ctx, state); err != nil {
		log.Printf("[charity-model-monitor] save state: %v", err)
	}
}

func (w *CharityModelMonitorWorker) checkSite(ctx context.Context, cfg CharityModelMonitorConfig, site model.CharityModelMonitorSite, codexVersion string) (model.CharityModelMonitorSiteState, []model.CharityModelMonitorProviderState, error) {
	var targets []string
	var gptModels []string
	var claudeModels []string
	if !site.SyncCodexHeadersOnly {
		catalog, err := w.fetchModelCatalog(ctx, site)
		if err != nil {
			return model.CharityModelMonitorSiteState{}, nil, err
		}
		targets, gptModels, claudeModels = catalog.targets, catalog.gpt, catalog.claude
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
		// Pass the full pricing/status catalog for Codex. Custom model lists may include
		// glm/deepseek/grok; pattern mode still filters to gpt-* inside syncProvider.
		codexAvailable := targets
		if len(codexAvailable) == 0 {
			codexAvailable = gptModels
		}
		result, err := w.syncProvider(ctx, cfg, configData, site, "Codex", site.CodexProviderSection, site.CodexBaseURL, codexAvailable, codexProviderHeaders(codexVersion), site.SyncCodexHeadersOnly)
		if err != nil {
			return state, results, err
		}
		results = append(results, result)
	}
	if site.ClaudeBaseURL != "" && site.MonitorClaude && !site.SyncCodexHeadersOnly {
		claudeAvailable := targets
		if len(claudeAvailable) == 0 {
			claudeAvailable = claudeModels
		}
		result, err := w.syncProvider(ctx, cfg, configData, site, "Claude", site.ClaudeProviderSection, site.ClaudeBaseURL, claudeAvailable, nil, false)
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

type charityModelCatalog struct {
	targets []string
	gpt     []string
	claude  []string
	source  string
}

func (w *CharityModelMonitorWorker) fetchModelCatalog(ctx context.Context, site model.CharityModelMonitorSite) (charityModelCatalog, error) {
	statusURL := strings.TrimSpace(site.StatusURL)
	var statusErr error
	if statusURL != "" {
		statusData, err := w.fetchJSON(ctx, statusURL, site.Referer)
		if err == nil {
			targets, gpt, claude := extractModelStatusModels(statusData, site.StatusAllow)
			if len(targets) > 0 {
				return charityModelCatalog{targets: targets, gpt: gpt, claude: claude, source: "model-status"}, nil
			}
		} else {
			statusErr = fmt.Errorf("model-status: %w", err)
		}
		// A failed or empty status endpoint falls back to pricing when configured.
		if strings.TrimSpace(site.PricingURL) == "" {
			if statusErr != nil {
				return charityModelCatalog{}, statusErr
			}
			return charityModelCatalog{source: "model-status"}, nil
		}
	}
	if strings.TrimSpace(site.PricingURL) == "" {
		return charityModelCatalog{}, errors.New("pricing/status URL is empty")
	}
	pricing, err := w.fetchPricing(ctx, site)
	if err != nil {
		if statusErr != nil {
			return charityModelCatalog{}, fmt.Errorf("%v; pricing: %w", statusErr, err)
		}
		return charityModelCatalog{}, err
	}
	targets, gpt, claude := extractCharityModels(pricing)
	return charityModelCatalog{targets: targets, gpt: gpt, claude: claude, source: "pricing"}, nil
}

func (w *CharityModelMonitorWorker) fetchJSON(ctx context.Context, rawURL, referer string) (map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", charityMonitorUserAgent)
	req.Header.Set("Accept", "application/json, text/plain, */*")
	if referer = strings.TrimSpace(referer); referer != "" {
		req.Header.Set("Referer", referer)
	}
	res, err := w.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("request failed: %s", res.Status)
	}
	var data map[string]any
	if err := json.NewDecoder(res.Body).Decode(&data); err != nil {
		return nil, err
	}
	return data, nil
}

func (w *CharityModelMonitorWorker) fetchPricing(ctx context.Context, site model.CharityModelMonitorSite) (map[string]any, error) {
	pricingURL := strings.TrimSpace(site.PricingURL)
	if pricingURL == "" {
		return nil, errors.New("pricing URL is empty")
	}
	return w.fetchJSON(ctx, pricingURL, site.Referer)
}

// extractModelStatusModels reads NewAPI-style /api/model-status payloads.
// A model is available when current_status is in allow (default green/yellow).
func extractModelStatusModels(data map[string]any, allow []string) ([]string, []string, []string) {
	allowSet := map[string]struct{}{}
	if len(allow) == 0 {
		allow = model.DefaultModelStatusAllow()
	}
	for _, status := range allow {
		allowSet[strings.ToLower(strings.TrimSpace(status))] = struct{}{}
	}

	root := data
	if nested, ok := data["data"].(map[string]any); ok {
		root = nested
	}
	items, _ := root["models"].([]any)
	if items == nil {
		// Some deployments may put the array directly under data.
		if list, ok := data["data"].([]any); ok {
			items = list
		}
	}

	targets := map[string]struct{}{}
	gpt := map[string]struct{}{}
	claude := map[string]struct{}{}
	for _, item := range items {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name := strings.TrimSpace(fmt.Sprint(row["model_name"]))
		if name == "" || name == "<nil>" {
			name = strings.TrimSpace(fmt.Sprint(row["display_name"]))
		}
		lower := strings.ToLower(name)
		if name == "" || name == "<nil>" || strings.Contains(lower, "image") {
			continue
		}
		status := strings.ToLower(strings.TrimSpace(fmt.Sprint(row["current_status"])))
		if status == "" || status == "<nil>" {
			status = strings.ToLower(strings.TrimSpace(fmt.Sprint(row["status"])))
		}
		if _, ok := allowSet[status]; !ok {
			continue
		}
		targets[name] = struct{}{}
		switch {
		case strings.HasPrefix(lower, "gpt-"):
			gpt[name] = struct{}{}
		case strings.HasPrefix(lower, "claude-"):
			claude[name] = struct{}{}
		}
	}
	return sortedKeys(targets), sortedKeys(gpt), sortedKeys(claude)
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
		// Full catalog is used by custom-model mode so glm/deepseek/grok count.
		targets[name] = struct{}{}
		switch {
		case strings.HasPrefix(lower, "gpt-"):
			gpt[name] = struct{}{}
		case strings.HasPrefix(lower, "claude-"):
			claude[name] = struct{}{}
		}
	}
	return sortedKeys(targets), sortedKeys(gpt), sortedKeys(claude)
}

func filterModelsByPrefix(models []string, prefix string) []string {
	prefix = strings.ToLower(strings.TrimSpace(prefix))
	if prefix == "" {
		return append([]string(nil), models...)
	}
	result := make([]string, 0, len(models))
	for _, modelName := range models {
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(modelName)), prefix) {
			result = append(result, modelName)
		}
	}
	return result
}

func sortedKeys(values map[string]struct{}) []string {
	result := make([]string, 0, len(values))
	for value := range values {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func joinModelsForLog(values []string) string {
	if len(values) == 0 {
		return "-"
	}
	const maxItems = 8
	if len(values) <= maxItems {
		return strings.Join(values, ",")
	}
	return fmt.Sprintf("%s,...(+%d)", strings.Join(values[:maxItems], ","), len(values)-maxItems)
}

func logCharityProviderDecision(result model.CharityModelMonitorProviderState) {
	enabled := "off"
	if result.DesiredEnabled {
		enabled = "on"
	}
	log.Printf(
		"[charity-model-monitor] decision site=%s label=%s section=%s provider=%s mode=%s enabled=%s changed=%t switch=%t headers=%t custom=%d matched=%d missing=%d excluded=%d reason=%q matchedModels=%s missingModels=%s excludedModels=%s",
		result.Site,
		result.Label,
		result.Section,
		result.Provider,
		result.CheckMode,
		enabled,
		result.Changed,
		result.SwitchChanged,
		result.HeadersChanged,
		len(result.CustomModels),
		len(result.MatchedModels),
		len(result.MissingModels),
		len(result.ExcludedModels),
		result.Reason,
		joinModelsForLog(result.MatchedModels),
		joinModelsForLog(result.MissingModels),
		joinModelsForLog(result.ExcludedModels),
	)
}

func cloneProviderResults(results []model.CharityModelMonitorProviderState) []model.CharityModelMonitorProviderState {
	if len(results) == 0 {
		return nil
	}
	out := make([]model.CharityModelMonitorProviderState, len(results))
	copy(out, results)
	return out
}

func appendCharityHistory(history []model.CharityModelMonitorHistoryEntry, entry model.CharityModelMonitorHistoryEntry) []model.CharityModelMonitorHistoryEntry {
	next := append(append([]model.CharityModelMonitorHistoryEntry(nil), history...), entry)
	if len(next) <= model.MaxCharityModelMonitorHistory {
		return next
	}
	return append([]model.CharityModelMonitorHistoryEntry(nil), next[len(next)-model.MaxCharityModelMonitorHistory:]...)
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

func missingModels(wanted []string, available []string) []string {
	availableSet := map[string]struct{}{}
	for _, modelName := range available {
		key := strings.ToLower(strings.TrimSpace(modelName))
		if key != "" {
			availableSet[key] = struct{}{}
		}
	}
	missing := map[string]struct{}{}
	for _, modelName := range wanted {
		name := strings.TrimSpace(modelName)
		if name == "" {
			continue
		}
		key := strings.ToLower(name)
		if _, ok := availableSet[key]; !ok {
			missing[name] = struct{}{}
		}
	}
	return sortedKeys(missing)
}

// setManagedModelExclusions rewrites excluded-models for custom-model channels.
// Custom mode fully owns this list so add/remove of custom models cannot leave
// ghost exclusions behind:
// - fullyDisabled=true  => ["*"] only (whole channel off)
// - fullyDisabled=false => exactly the currently missing managed models
// managedModels is kept for call-site clarity / future use.
func setManagedModelExclusions(entry map[string]any, fullyDisabled bool, excludeModels []string, managedModels []string) bool {
	_ = managedModels
	current := excludedModels(entry["excluded-models"])
	before := strings.Join(current, "\x00")

	next := make([]string, 0, len(excludeModels)+1)
	if fullyDisabled {
		next = append(next, charityMonitorDisableAllModelsRule)
	} else {
		for _, modelName := range excludeModels {
			name := strings.TrimSpace(modelName)
			if name == "" {
				continue
			}
			next = append(next, name)
		}
	}

	seen := map[string]struct{}{}
	deduped := make([]string, 0, len(next))
	for _, item := range next {
		key := strings.ToLower(strings.TrimSpace(item))
		if key == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		deduped = append(deduped, strings.TrimSpace(item))
	}
	sort.SliceStable(deduped, func(i, j int) bool {
		// Keep "*" last so whole-channel disable is easy to spot.
		if deduped[i] == charityMonitorDisableAllModelsRule {
			return false
		}
		if deduped[j] == charityMonitorDisableAllModelsRule {
			return true
		}
		return strings.ToLower(deduped[i]) < strings.ToLower(deduped[j])
	})

	if len(deduped) == 0 {
		delete(entry, "excluded-models")
	} else {
		entry["excluded-models"] = deduped
	}
	return before != strings.Join(deduped, "\x00")
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
	// Pattern mode still only watches gpt-* / claude-*; custom mode uses the full catalog.
	patternAvailable := availableModels
	if strings.EqualFold(label, "Claude") || strings.Contains(strings.ToLower(section), "claude") {
		patternAvailable = filterModelsByPrefix(availableModels, "claude-")
	} else {
		patternAvailable = filterModelsByPrefix(availableModels, "gpt-")
	}
	matchedModels := patternAvailable
	missing := []string(nil)
	excludeModels := []string(nil)
	managedModels := []string(nil)
	enable := len(patternAvailable) > 0
	if len(customModels) > 0 {
		// Fine-grained mode: keep channel open when any custom model is available,
		// and only exclude the missing ones. Full disable only when all are gone.
		// Compare against the full pricing catalog (not just gpt-*).
		checkMode = "custom"
		matchedModels = intersectModels(customModels, availableModels)
		missing = missingModels(customModels, availableModels)
		managedModels = customModels
		enable = len(matchedModels) > 0
		if enable {
			excludeModels = missing
		}
	}
	desiredDisabled := !enable
	if preserveSwitch {
		desiredDisabled = isDisabledByExcludedModels(matched[0].Entry)
		matchedModels = nil
		missing = nil
		excludeModels = nil
		managedModels = nil
	}
	switchChanged := false
	headersChanged := false
	finalExcluded := []string(nil)
	for _, matchedEntry := range matched {
		entry := matchedEntry.Entry
		if !preserveSwitch {
			if checkMode == "custom" {
				switchChanged = setManagedModelExclusions(entry, desiredDisabled, excludeModels, managedModels) || switchChanged
			} else {
				// Pattern mode is whole-channel only; fully rewrite so leftover
				// per-model exclusions from a previous custom list cannot stick.
				switchChanged = setManagedModelExclusions(entry, desiredDisabled, nil, nil) || switchChanged
			}
			finalExcluded = excludedModels(entry["excluded-models"])
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
	if preserveSwitch {
		reason = "headers only"
	} else if checkMode == "custom" {
		switch {
		case !enable:
			reason = "all custom models missing"
		case len(excludeModels) > 0:
			reason = "partial custom models available; excluded missing"
		default:
			reason = "all custom models available"
		}
	} else if !enable {
		reason = "no matching model"
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
		MissingModels:  missing,
		ExcludedModels: finalExcluded,
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
