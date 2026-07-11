package worker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	collectorpkg "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/collector"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/cpa"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/cpaauthfiles"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

const (
	quotaAutoDisableQueueSize     = 256
	quotaAutoDisableDefaultTick   = 15 * time.Second
	quotaAutoDisableActionTimeout = 30 * time.Second
	quotaCooldownDueLimit         = 100
	antigravityDefaultProjectID   = "bamboo-precept-lgxtn"
)

var antigravityQuotaCheckURLs = []string{
	"https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
	"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
	"https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
}

// RateLimitAutoDisableWorker reacts to request-monitoring events in near real time.
// It handles quota 429 usage_limit_reached responses that include an explicit
// reset time. Disables are persisted with CPAMP ownership, so recovery never relies
// solely on in-memory timers and never re-enables pre-existing/manual disables.
type RateLimitAutoDisableWorker struct {
	store  *store.Store
	client *http.Client

	jobs chan quotaAutoDisableCandidate

	mu                  sync.RWMutex
	baseURL             string
	managementKey       string
	enableCheckInterval time.Duration
}

type quotaAutoDisableCandidate struct {
	BaseURL         string
	ManagementKey   string
	FileName        string
	AuthIndex       string
	DisplayAccount  string
	Provider        string
	ProviderSection string
	ProviderBaseURL string
	SourceHash      string
	ResetAt         time.Time
	EventHash       string
	Reason          string
	HTTPStatusCode  int
	TriggerCount    int64
}

type authFile = cpaauthfiles.File

func NewRateLimitAutoDisableWorker(st *store.Store, initial ...collectorpkg.RuntimeConfig) *RateLimitAutoDisableWorker {
	w := &RateLimitAutoDisableWorker{
		store:               st,
		client:              &http.Client{Timeout: quotaAutoDisableActionTimeout},
		jobs:                make(chan quotaAutoDisableCandidate, quotaAutoDisableQueueSize),
		enableCheckInterval: quotaAutoDisableDefaultTick,
	}
	if len(initial) > 0 {
		w.setRuntimeConfig(initial[0].CPAUpstreamURL, initial[0].ManagementKey)
	}
	return w
}

func (w *RateLimitAutoDisableWorker) Start(ctx context.Context) {
	go w.run(ctx)
}

func (w *RateLimitAutoDisableWorker) UpdateRuntimeConfig(ctx context.Context, cfg collectorpkg.RuntimeConfig) {
	if w == nil {
		return
	}
	baseURL := strings.TrimSpace(cfg.CPAUpstreamURL)
	managementKey := strings.TrimSpace(cfg.ManagementKey)
	if baseURL == "" || managementKey == "" {
		return
	}
	if w.setRuntimeConfig(baseURL, managementKey) {
		log.Printf("[quota-auto-disable] runtime config synced baseURL=%q managementKeySet=%t", baseURL, managementKey != "")
	}
	w.enableDue(ctx, time.Now())
}

// HandleUsageEvents is called by the request-monitoring collector after raw CPA
// usage events are normalized and enriched with auth-file snapshots. It does not
// poll historical events; it only reacts to newly observed request failures.
func (w *RateLimitAutoDisableWorker) HandleUsageEvents(ctx context.Context, cfg collectorpkg.RuntimeConfig, events []usage.Event) {
	if w == nil {
		return
	}
	baseURL := strings.TrimSpace(cfg.CPAUpstreamURL)
	managementKey := strings.TrimSpace(cfg.ManagementKey)
	if baseURL == "" || managementKey == "" {
		return
	}
	if w.setRuntimeConfig(baseURL, managementKey) {
		log.Printf("[quota-auto-disable] runtime config synced baseURL=%q managementKeySet=%t", baseURL, managementKey != "")
	}
	if len(events) == 0 {
		return
	}
	now := time.Now()
	for _, event := range events {
		candidate, ok := w.quotaAutoDisableCandidateFromEvent(ctx, event, cfg, baseURL, managementKey, now)
		if !ok {
			continue
		}
		select {
		case w.jobs <- candidate:
		case <-ctx.Done():
			return
		default:
			log.Printf("[quota-auto-disable] job queue full, dropped auth file %q event=%q", candidate.FileName, candidate.EventHash)
		}
	}
}

func (w *RateLimitAutoDisableWorker) run(ctx context.Context) {
	interval := w.enableCheckInterval
	if interval <= 0 {
		interval = quotaAutoDisableDefaultTick
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	w.enableDue(ctx, time.Now())
	for {
		select {
		case <-ctx.Done():
			return
		case candidate := <-w.jobs:
			w.handleCandidate(ctx, candidate)
		case <-ticker.C:
			w.enableDue(ctx, time.Now())
		}
	}
}

func (w *RateLimitAutoDisableWorker) setRuntimeConfig(baseURL string, managementKey string) bool {
	baseURL = strings.TrimSpace(baseURL)
	managementKey = strings.TrimSpace(managementKey)
	w.mu.Lock()
	defer w.mu.Unlock()
	changed := w.baseURL != baseURL || w.managementKey != managementKey
	w.baseURL = baseURL
	w.managementKey = managementKey
	return changed
}

func (w *RateLimitAutoDisableWorker) runtimeConfig() (string, string) {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.baseURL, w.managementKey
}

func (w *RateLimitAutoDisableWorker) handleCandidate(ctx context.Context, candidate quotaAutoDisableCandidate) {
	if candidate.ProviderSection != "" && candidate.ProviderBaseURL != "" && candidate.HTTPStatusCode == http.StatusInternalServerError {
		w.handleAIProviderCandidate(ctx, candidate)
		return
	}
	if w == nil || w.store == nil || w.store.QuotaCooldowns == nil {
		log.Printf("[quota-auto-disable] store unavailable, skip auth file %q", candidate.FileName)
		return
	}
	if candidate.FileName == "" || candidate.BaseURL == "" || candidate.ManagementKey == "" {
		return
	}
	now := time.Now()
	if !candidate.ResetAt.After(now) {
		log.Printf("[quota-auto-disable] quota event for auth file %q has non-future reset time %s, skip auto disable", candidate.FileName, candidate.ResetAt.Format(time.RFC3339))
		return
	}

	current, ok, err := w.currentAuthFile(ctx, candidate.BaseURL, candidate.ManagementKey, candidate.FileName, candidate.AuthIndex)
	if err != nil {
		log.Printf("[quota-auto-disable] failed to verify auth file %q before disable: %v", candidate.FileName, err)
		return
	}
	if !ok {
		log.Printf("[quota-auto-disable] auth file %q authIndex=%q not found/currently mismatched, skip auto disable", candidate.FileName, candidate.AuthIndex)
		return
	}
	preDisabled := current.Disabled
	if preDisabled {
		if w.extendExistingCooldown(ctx, candidate, current) {
			return
		}
		log.Printf("[quota-auto-disable] auth file %q was already disabled without CPAMP ownership; skip auto disable/recovery", candidate.FileName)
		return
	}

	resolvedAuthIndex := firstNonEmpty(candidate.AuthIndex, current.AuthIndex)
	if candidate.HTTPStatusCode == http.StatusInternalServerError {
		log.Printf("[quota-auto-disable] HTTP 500 threshold reached for auth file %q account=%q count=%d resetAt=%s, disabling", candidate.FileName, candidate.DisplayAccount, candidate.TriggerCount, candidate.ResetAt.Format(time.RFC3339))
	} else {
		log.Printf("[quota-auto-disable] %s usage limit reached for auth file %q account=%q resetAt=%s, disabling", candidate.Provider, candidate.FileName, candidate.DisplayAccount, candidate.ResetAt.Format(time.RFC3339))
	}
	if err := w.patchAuthFile(ctx, candidate.BaseURL, candidate.ManagementKey, candidate.FileName, resolvedAuthIndex, true); err != nil {
		log.Printf("[quota-auto-disable] failed to disable auth file %q: %v", candidate.FileName, err)
		return
	}

	_, err = w.store.UpsertQuotaCooldown(ctx, store.QuotaCooldownUpsert{
		AuthFileName:     candidate.FileName,
		AuthIndex:        resolvedAuthIndex,
		AccountSnapshot:  candidate.DisplayAccount,
		Provider:         strings.ToLower(strings.TrimSpace(candidate.Provider)),
		RecoverAtMS:      candidate.ResetAt.UnixMilli(),
		Owner:            model.QuotaCooldownOwnerUsage429,
		EventHash:        candidate.EventHash,
		PreDisabledState: preDisabled,
		DisabledAtMS:     now.UnixMilli(),
	})
	if err != nil {
		log.Printf("[quota-auto-disable] disabled auth file %q but failed to persist cooldown ownership: %v", candidate.FileName, err)
		if rollbackErr := w.patchAuthFile(ctx, candidate.BaseURL, candidate.ManagementKey, candidate.FileName, resolvedAuthIndex, false); rollbackErr != nil {
			log.Printf("[quota-auto-disable] failed to roll back auth file %q after cooldown persistence error: %v", candidate.FileName, rollbackErr)
		}
		return
	}
	log.Printf("[quota-auto-disable] disabled auth file %q; persisted CPAMP-owned auto-enable at %s", candidate.FileName, candidate.ResetAt.Format(time.RFC3339))
}

func (w *RateLimitAutoDisableWorker) handleAIProviderCandidate(ctx context.Context, candidate quotaAutoDisableCandidate) {
	if w == nil || w.store == nil || w.store.QuotaCooldowns == nil {
		return
	}
	now := time.Now()
	if !candidate.ResetAt.After(now) {
		return
	}
	preDisabled, changed, err := w.setAIProviderChannelDisabled(ctx, candidate.BaseURL, candidate.ManagementKey, candidate.ProviderSection, candidate.ProviderBaseURL, true)
	if err != nil {
		log.Printf("[quota-auto-disable] failed to close AI provider channel %q: %v", candidate.ProviderBaseURL, err)
		return
	}
	if preDisabled && !changed {
		log.Printf("[quota-auto-disable] AI provider channel %q already closed before CPAMP action; skip ownership", candidate.ProviderBaseURL)
		return
	}
	_, err = w.store.UpsertQuotaCooldown(ctx, store.QuotaCooldownUpsert{
		AuthFileName:     candidate.FileName,
		AccountSnapshot:  candidate.ProviderBaseURL,
		Provider:         candidate.ProviderSection,
		RecoverAtMS:      candidate.ResetAt.UnixMilli(),
		Owner:            model.QuotaCooldownOwnerHTTP500Provider,
		EventHash:        candidate.EventHash,
		PreDisabledState: preDisabled,
		DisabledAtMS:     now.UnixMilli(),
	})
	if err != nil {
		if changed {
			_, _, _ = w.setAIProviderChannelDisabled(ctx, candidate.BaseURL, candidate.ManagementKey, candidate.ProviderSection, candidate.ProviderBaseURL, false)
		}
		log.Printf("[quota-auto-disable] closed AI provider channel %q but failed to persist recovery: %v", candidate.ProviderBaseURL, err)
		return
	}
	log.Printf("[quota-auto-disable] HTTP 500 threshold reached for AI provider %q count=%d; channel closed until %s", candidate.ProviderBaseURL, candidate.TriggerCount, candidate.ResetAt.Format(time.RFC3339))
}

func (w *RateLimitAutoDisableWorker) extendExistingCooldown(ctx context.Context, candidate quotaAutoDisableCandidate, current authFile) bool {
	active, err := w.store.QuotaCooldowns.ListActive(ctx)
	if err != nil {
		log.Printf("[quota-auto-disable] failed to check active cooldowns for auth file %q: %v", candidate.FileName, err)
		return false
	}
	var existing store.QuotaCooldown
	for _, item := range active {
		if item.AuthFileName == candidate.FileName && item.Owner == model.QuotaCooldownOwnerUsage429 {
			existing = item
			break
		}
	}
	if existing.ID == 0 {
		return false
	}
	currentIndex := current.AuthIndex
	if existing.AuthIndex != "" && currentIndex != existing.AuthIndex {
		log.Printf("[quota-auto-disable] active cooldown auth index mismatch for auth file %q: stored=%q current=%q", candidate.FileName, existing.AuthIndex, currentIndex)
		return false
	}
	_, err = w.store.UpsertQuotaCooldown(ctx, store.QuotaCooldownUpsert{
		AuthFileName:     candidate.FileName,
		AuthIndex:        firstNonEmpty(candidate.AuthIndex, existing.AuthIndex, current.AuthIndex),
		AccountSnapshot:  firstNonEmpty(candidate.DisplayAccount, existing.AccountSnapshot),
		Provider:         strings.ToLower(strings.TrimSpace(firstNonEmpty(candidate.Provider, existing.Provider))),
		RecoverAtMS:      candidate.ResetAt.UnixMilli(),
		Owner:            model.QuotaCooldownOwnerUsage429,
		EventHash:        candidate.EventHash,
		PreDisabledState: false,
		DisabledAtMS:     existing.DisabledAtMS,
	})
	if err != nil {
		log.Printf("[quota-auto-disable] failed to extend active cooldown for auth file %q: %v", candidate.FileName, err)
		return false
	}
	log.Printf("[quota-auto-disable] extended CPAMP-owned auth file %q auto-enable time to %s", candidate.FileName, candidate.ResetAt.Format(time.RFC3339))
	return true
}

func (w *RateLimitAutoDisableWorker) enableDue(ctx context.Context, now time.Time) {
	if w == nil || w.store == nil || w.store.QuotaCooldowns == nil {
		return
	}
	baseURL, managementKey := w.runtimeConfig()
	if baseURL == "" || managementKey == "" {
		return
	}
	due, err := w.store.ListDueQuotaCooldowns(ctx, now.UnixMilli(), quotaCooldownDueLimit)
	if err != nil {
		log.Printf("[quota-auto-disable] failed to list due quota cooldowns: %v", err)
		return
	}
	for _, item := range due {
		w.recoverCooldown(ctx, baseURL, managementKey, item, now)
	}
}

func (w *RateLimitAutoDisableWorker) recoverCooldown(ctx context.Context, baseURL string, managementKey string, item store.QuotaCooldown, now time.Time) {
	if item.Owner == model.QuotaCooldownOwnerHTTP500Provider {
		w.recoverAIProviderCooldown(ctx, baseURL, managementKey, item, now)
		return
	}
	if item.Owner != model.QuotaCooldownOwnerUsage429 {
		reason := "unknown owner"
		_ = w.store.MarkQuotaCooldownSkipped(ctx, item.ID, reason)
		log.Printf("[quota-auto-disable] skip cooldown recovery id=%d authFile=%q reason=%s owner=%q", item.ID, item.AuthFileName, reason, item.Owner)
		return
	}
	if item.PreDisabledState {
		reason := "pre-disabled before CPAMP action"
		_ = w.store.MarkQuotaCooldownSkipped(ctx, item.ID, reason)
		log.Printf("[quota-auto-disable] skip cooldown recovery id=%d authFile=%q reason=%s", item.ID, item.AuthFileName, reason)
		return
	}
	current, ok, err := w.currentAuthFile(ctx, baseURL, managementKey, item.AuthFileName, item.AuthIndex)
	if err != nil {
		_ = w.store.RecordQuotaCooldownFailure(ctx, item.ID, err.Error())
		log.Printf("[quota-auto-disable] failed to verify auth file %q before recovery: %v", item.AuthFileName, err)
		return
	}
	if !ok {
		_ = w.store.MarkQuotaCooldownSkipped(ctx, item.ID, "auth file missing or auth index mismatch")
		log.Printf("[quota-auto-disable] auth file %q authIndex=%q missing/mismatched, skip auto-enable", item.AuthFileName, item.AuthIndex)
		return
	}
	if !current.Disabled {
		_ = w.store.MarkQuotaCooldownRecovered(ctx, item.ID, now.UnixMilli())
		log.Printf("[quota-auto-disable] auth file %q already enabled; marked cooldown recovered", item.AuthFileName)
		return
	}

	log.Printf("[quota-auto-disable] reset time reached for auth file %q account=%q, enabling", item.AuthFileName, item.AccountSnapshot)
	if err := w.patchAuthFile(ctx, baseURL, managementKey, item.AuthFileName, item.AuthIndex, false); err != nil {
		_ = w.store.RecordQuotaCooldownFailure(ctx, item.ID, err.Error())
		log.Printf("[quota-auto-disable] failed to enable auth file %q: %v", item.AuthFileName, err)
		return
	}
	if err := w.store.MarkQuotaCooldownRecovered(ctx, item.ID, now.UnixMilli()); err != nil {
		log.Printf("[quota-auto-disable] enabled auth file %q but failed to mark cooldown recovered: %v", item.AuthFileName, err)
		return
	}
	log.Printf("[quota-auto-disable] enabled auth file %q after %s usage-limit reset", item.AuthFileName, item.Provider)
}

type aiProviderChannel struct {
	Section string
	BaseURL string
}

func aiProviderCooldownKey(section string, baseURL string) string {
	return "ai-provider:" + strings.TrimSpace(section) + ":" + normalizeURL(baseURL)
}

func shortHash(value string) string {
	value = strings.TrimSpace(value)
	if len(value) <= 10 {
		return value
	}
	return value[:10]
}

func hashProviderAPIKey(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func providerAPIKeys(entry map[string]any) []string {
	raw := entry["api-key"]
	switch typed := raw.(type) {
	case string:
		return []string{typed}
	case []any:
		result := make([]string, 0, len(typed))
		for _, item := range typed {
			if value := strings.TrimSpace(fmt.Sprint(item)); value != "" {
				result = append(result, value)
			}
		}
		return result
	case []string:
		return typed
	default:
		return nil
	}
}

func (w *RateLimitAutoDisableWorker) findAIProviderChannel(ctx context.Context, baseURL string, managementKey string, event usage.Event) (aiProviderChannel, bool) {
	sourceHash := strings.TrimSpace(event.SourceHash)
	if sourceHash == "" {
		return aiProviderChannel{}, false
	}
	configData, err := w.managementConfigRequest(ctx, baseURL, managementKey, http.MethodGet, "/config", nil)
	if err != nil {
		log.Printf("[quota-auto-disable] failed to read AI provider config for HTTP 500 event: %v", err)
		return aiProviderChannel{}, false
	}
	sections := []string{"codex-api-key", "claude-api-key"}
	provider := strings.ToLower(strings.TrimSpace(firstNonEmpty(event.Provider, event.AuthProviderSnapshot)))
	if provider == "claude" {
		sections = []string{"claude-api-key", "codex-api-key"}
	}
	for _, section := range sections {
		entries, _ := configData[section].([]any)
		for _, raw := range entries {
			entry, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			for _, key := range providerAPIKeys(entry) {
				if hashProviderAPIKey(key) == sourceHash {
					return aiProviderChannel{Section: section, BaseURL: strings.TrimSpace(fmt.Sprint(entry["base-url"]))}, true
				}
			}
		}
	}
	return aiProviderChannel{}, false
}

func (w *RateLimitAutoDisableWorker) setAIProviderChannelDisabled(ctx context.Context, baseURL string, managementKey string, section string, providerBaseURL string, disabled bool) (bool, bool, error) {
	configData, err := w.managementConfigRequest(ctx, baseURL, managementKey, http.MethodGet, "/config", nil)
	if err != nil {
		return false, false, err
	}
	entries, ok := configData[section].([]any)
	if !ok {
		return false, false, fmt.Errorf("AI provider section %q is not a list", section)
	}
	matched := false
	preDisabled := false
	changed := false
	for _, raw := range entries {
		entry, ok := raw.(map[string]any)
		if !ok || normalizeURL(fmt.Sprint(entry["base-url"])) != normalizeURL(providerBaseURL) {
			continue
		}
		matched = true
		preDisabled = isDisabledByExcludedModels(entry)
		changed = setDisabledByExcludedModels(entry, disabled) || changed
		delete(entry, "auth-index")
	}
	if !matched {
		return false, false, fmt.Errorf("AI provider not found: %s %s", section, providerBaseURL)
	}
	if changed {
		if _, err := w.managementConfigRequest(ctx, baseURL, managementKey, http.MethodPut, "/"+section, entries); err != nil {
			return preDisabled, false, err
		}
	}
	return preDisabled, changed, nil
}

func (w *RateLimitAutoDisableWorker) recoverAIProviderCooldown(ctx context.Context, baseURL string, managementKey string, item store.QuotaCooldown, now time.Time) {
	section := strings.TrimSpace(item.Provider)
	providerBaseURL := strings.TrimSpace(item.AccountSnapshot)
	if section == "" || providerBaseURL == "" {
		_ = w.store.MarkQuotaCooldownSkipped(ctx, item.ID, "AI provider section/base URL missing")
		return
	}
	_, _, err := w.setAIProviderChannelDisabled(ctx, baseURL, managementKey, section, providerBaseURL, false)
	if err != nil {
		_ = w.store.RecordQuotaCooldownFailure(ctx, item.ID, err.Error())
		log.Printf("[quota-auto-disable] failed to reopen AI provider channel %q: %v", providerBaseURL, err)
		return
	}
	if err := w.store.MarkQuotaCooldownRecovered(ctx, item.ID, now.UnixMilli()); err != nil {
		log.Printf("[quota-auto-disable] reopened AI provider channel %q but failed to mark recovery: %v", providerBaseURL, err)
		return
	}
	log.Printf("[quota-auto-disable] reopened AI provider channel %q after HTTP 500 cooldown", providerBaseURL)
}

func (w *RateLimitAutoDisableWorker) managementConfigRequest(ctx context.Context, baseURL string, managementKey string, method string, path string, payload any) (map[string]any, error) {
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
	reqCtx, cancel := context.WithTimeout(ctx, quotaAutoDisableActionTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, method, cpa.NormalizeBaseURL(baseURL)+"/v0/management"+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+managementKey)
	req.Header.Set("Accept", "application/json")
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
		return map[string]any{}, nil
	}
	return data, nil
}

func (w *RateLimitAutoDisableWorker) quotaAutoDisableCandidateFromEvent(ctx context.Context, event usage.Event, cfg collectorpkg.RuntimeConfig, baseURL string, managementKey string, now time.Time) (quotaAutoDisableCandidate, bool) {
	provider := strings.ToLower(strings.TrimSpace(firstNonEmpty(event.Provider, event.AuthProviderSnapshot)))
	fileName := strings.TrimSpace(event.AuthFileSnapshot)
	if event.Failed && event.FailStatusCode == http.StatusInternalServerError {
		channel, ok := w.findAIProviderChannel(ctx, baseURL, managementKey, event)
		if !ok {
			log.Printf("[quota-auto-disable] HTTP 500 event %q cannot be matched to an AI provider channel, skip", event.EventHash)
			return quotaAutoDisableCandidate{}, false
		}
		resetAt, count, ok := w.http500ProviderCooldownResetTime(ctx, event, cfg, now)
		if !ok {
			return quotaAutoDisableCandidate{}, false
		}
		return quotaAutoDisableCandidate{
			BaseURL:         baseURL,
			ManagementKey:   managementKey,
			FileName:        aiProviderCooldownKey(channel.Section, channel.BaseURL),
			DisplayAccount:  channel.BaseURL,
			Provider:        provider,
			ProviderSection: channel.Section,
			ProviderBaseURL: channel.BaseURL,
			SourceHash:      event.SourceHash,
			ResetAt:         resetAt,
			EventHash:       event.EventHash,
			Reason:          event.FailSummary,
			HTTPStatusCode:  event.FailStatusCode,
			TriggerCount:    count,
		}, true
	}
	if fileName == "" {
		if event.Failed && event.FailStatusCode == http.StatusTooManyRequests {
			log.Printf("[quota-auto-disable] %s 429 event %q has no auth file snapshot, skip account quota cooldown", provider, event.EventHash)
		}
		return quotaAutoDisableCandidate{}, false
	}
	var resetAt time.Time
	var ok bool
	if provider == "antigravity" && event.Failed && event.FailStatusCode == http.StatusTooManyRequests {
		resetAt, ok = w.antigravityQuotaResetTime(ctx, baseURL, managementKey, event, fileName, now)
	}
	if !ok {
		resetAt, ok = quotaUsageLimitResetTimeFromEvent(event, now, provider)
	}
	if !ok {
		return quotaAutoDisableCandidate{}, false
	}
	return quotaAutoDisableCandidate{
		BaseURL:        baseURL,
		ManagementKey:  managementKey,
		FileName:       fileName,
		AuthIndex:      strings.TrimSpace(event.AuthIndex),
		DisplayAccount: firstNonEmpty(event.AccountSnapshot, event.AuthLabelSnapshot, event.Source, fileName),
		Provider:       provider,
		ResetAt:        resetAt,
		EventHash:      event.EventHash,
		Reason:         event.FailSummary,
		HTTPStatusCode: event.FailStatusCode,
	}, true
}

func quotaAutoDisableCandidateFromEvent(event usage.Event, baseURL string, managementKey string, now time.Time) (quotaAutoDisableCandidate, bool) {
	provider := strings.ToLower(strings.TrimSpace(firstNonEmpty(event.Provider, event.AuthProviderSnapshot)))
	fileName := strings.TrimSpace(event.AuthFileSnapshot)
	if fileName == "" {
		return quotaAutoDisableCandidate{}, false
	}
	resetAt, ok := quotaUsageLimitResetTimeFromEvent(event, now, provider)
	if !ok {
		return quotaAutoDisableCandidate{}, false
	}
	return quotaAutoDisableCandidate{
		BaseURL:        baseURL,
		ManagementKey:  managementKey,
		FileName:       fileName,
		AuthIndex:      strings.TrimSpace(event.AuthIndex),
		DisplayAccount: firstNonEmpty(event.AccountSnapshot, event.AuthLabelSnapshot, event.Source, fileName),
		Provider:       provider,
		ResetAt:        resetAt,
		EventHash:      event.EventHash,
		Reason:         event.FailSummary,
		HTTPStatusCode: event.FailStatusCode,
	}, true
}

func (w *RateLimitAutoDisableWorker) http500ProviderCooldownResetTime(ctx context.Context, event usage.Event, cfg collectorpkg.RuntimeConfig, now time.Time) (time.Time, int64, bool) {
	if w == nil || w.store == nil || strings.TrimSpace(event.SourceHash) == "" {
		return time.Time{}, 0, false
	}
	windowMinutes := model.NormalizeHTTP500CooldownWindowMinutes(cfg.HTTP500CooldownWindowMinutes)
	threshold := model.NormalizeHTTP500CooldownThreshold(cfg.HTTP500CooldownThreshold)
	durationMinutes := model.NormalizeHTTP500CooldownDurationMinutes(cfg.HTTP500CooldownDurationMinutes)
	sinceMS := now.Add(-time.Duration(windowMinutes) * time.Minute).UnixMilli()
	count, err := w.store.CountHTTP500ForSourceHashSince(ctx, event.SourceHash, sinceMS)
	if err != nil {
		log.Printf("[quota-auto-disable] failed to count HTTP 500 events for AI provider sourceHash=%s: %v", shortHash(event.SourceHash), err)
		return time.Time{}, 0, false
	}
	if count < int64(threshold) {
		log.Printf("[quota-auto-disable] HTTP 500 event for AI provider sourceHash=%s count=%d/%d window=%dm, keep channel open", shortHash(event.SourceHash), count, threshold, windowMinutes)
		return time.Time{}, count, false
	}
	return now.Add(time.Duration(durationMinutes) * time.Minute), count, true
}

func (w *RateLimitAutoDisableWorker) antigravityQuotaResetTime(ctx context.Context, baseURL string, managementKey string, event usage.Event, fileName string, now time.Time) (time.Time, bool) {
	authIndex := strings.TrimSpace(event.AuthIndex)
	if authIndex == "" {
		return time.Time{}, false
	}
	file, ok, err := w.currentAuthFile(ctx, baseURL, managementKey, fileName, authIndex)
	if err != nil {
		log.Printf("[quota-auto-disable] failed to fetch antigravity auth file %q before quota check: %v", fileName, err)
		return time.Time{}, false
	}
	if !ok {
		return time.Time{}, false
	}
	projectID := antigravityProjectIDFromAuthFile(file)
	for _, targetURL := range antigravityQuotaCheckURLs {
		payload, err := w.antigravityAPICall(ctx, baseURL, managementKey, authIndex, targetURL, projectID)
		if err != nil {
			log.Printf("[quota-auto-disable] antigravity quota check failed authFile=%q url=%q: %v", fileName, targetURL, err)
			continue
		}
		if resetAt, ok := antigravityExhaustedQuotaResetTime(payload, now); ok {
			return resetAt, true
		}
	}
	return time.Time{}, false
}

type antigravityAPICallResponse struct {
	StatusCode  int             `json:"status_code"`
	StatusCode2 int             `json:"statusCode"`
	Body        json.RawMessage `json:"body"`
	BodyText    string          `json:"bodyText"`
}

func (w *RateLimitAutoDisableWorker) antigravityAPICall(ctx context.Context, baseURL string, managementKey string, authIndex string, targetURL string, projectID string) (any, error) {
	payload := map[string]any{
		"authIndex": authIndex,
		"method":    http.MethodPost,
		"url":       targetURL,
		"header": map[string]string{
			"Authorization": "Bearer $TOKEN$",
			"Content-Type":  "application/json",
			"User-Agent":    "antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)",
		},
		"data": fmt.Sprintf(`{"project":%q}`, projectID),
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	reqCtx, cancel := context.WithTimeout(ctx, quotaAutoDisableActionTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, cpa.NormalizeBaseURL(baseURL)+"/v0/management/api-call", bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+managementKey)
	req.Header.Set("Content-Type", "application/json")
	res, err := w.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	responseBody, _ := io.ReadAll(io.LimitReader(res.Body, 2<<20))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("api-call HTTP %d", res.StatusCode)
	}
	var call antigravityAPICallResponse
	if err := json.Unmarshal(responseBody, &call); err != nil {
		return nil, err
	}
	statusCode := call.StatusCode
	if statusCode == 0 {
		statusCode = call.StatusCode2
	}
	if statusCode < 200 || statusCode >= 300 {
		return nil, fmt.Errorf("api-call upstream HTTP %d", statusCode)
	}
	if len(call.Body) > 0 && string(call.Body) != "null" {
		var result any
		if err := json.Unmarshal(call.Body, &result); err == nil {
			if text, ok := result.(string); ok {
				var nested any
				if json.Unmarshal([]byte(text), &nested) == nil {
					return nested, nil
				}
			}
			return result, nil
		}
	}
	if strings.TrimSpace(call.BodyText) != "" {
		var result any
		if err := json.Unmarshal([]byte(call.BodyText), &result); err == nil {
			return result, nil
		}
	}
	return nil, fmt.Errorf("empty antigravity quota payload")
}

func antigravityProjectIDFromAuthFile(file authFile) string {
	for _, key := range []string{"project_id", "projectId"} {
		if value := stringFromMap(file.Raw, key); value != "" {
			return value
		}
	}
	for _, parent := range []string{"metadata", "attributes", "installed", "web"} {
		if child, ok := file.Raw[parent].(map[string]any); ok {
			for _, key := range []string{"project_id", "projectId", "gemini_virtual_project"} {
				if value := stringFromMap(child, key); value != "" {
					return value
				}
			}
		}
	}
	return antigravityDefaultProjectID
}

func stringFromMap(value map[string]any, key string) string {
	if value == nil || value[key] == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value[key]))
}

func antigravityExhaustedQuotaResetTime(payload any, now time.Time) (time.Time, bool) {
	root, ok := payload.(map[string]any)
	if !ok {
		return time.Time{}, false
	}
	if nested, ok := root["body"].(map[string]any); ok {
		root = nested
	}
	groups, ok := root["groups"].([]any)
	if !ok {
		return time.Time{}, false
	}
	var latest time.Time
	for _, rawGroup := range groups {
		group, ok := rawGroup.(map[string]any)
		if !ok {
			continue
		}
		buckets, ok := group["buckets"].([]any)
		if !ok {
			continue
		}
		for _, rawBucket := range buckets {
			bucket, ok := rawBucket.(map[string]any)
			if !ok {
				continue
			}
			remaining, present := antigravityRemainingFraction(bucket)
			if !present || remaining > 0 {
				continue
			}
			resetAt, ok := antigravityBucketResetTime(bucket, now)
			if !ok || !resetAt.After(now) {
				continue
			}
			if latest.IsZero() || resetAt.After(latest) {
				latest = resetAt
			}
		}
	}
	return latest, !latest.IsZero()
}

func antigravityRemainingFraction(bucket map[string]any) (float64, bool) {
	for _, key := range []string{"remainingFraction", "remaining_fraction", "remaining"} {
		if raw, ok := bucket[key]; ok {
			return floatFromAny(raw)
		}
	}
	return 0, false
}

func antigravityBucketResetTime(bucket map[string]any, now time.Time) (time.Time, bool) {
	for _, key := range []string{"resetTime", "reset_time"} {
		if raw, ok := bucket[key]; ok {
			return parseResetValue(raw, now, false)
		}
	}
	return time.Time{}, false
}

func floatFromAny(value any) (float64, bool) {
	switch typed := value.(type) {
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	case float64:
		return typed, true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case string:
		original := strings.TrimSpace(typed)
		percent := strings.HasSuffix(original, "%")
		text := strings.TrimSpace(strings.TrimSuffix(original, "%"))
		parsed, err := strconv.ParseFloat(text, 64)
		if err != nil {
			return 0, false
		}
		if percent {
			parsed /= 100
		}
		return parsed, true
	default:
		return 0, false
	}
}

func quotaUsageLimitResetTimeFromEvent(event usage.Event, now time.Time, provider string) (time.Time, bool) {
	if !event.Failed || event.FailStatusCode != http.StatusTooManyRequests {
		return time.Time{}, false
	}
	if provider != "codex" && provider != "antigravity" {
		return time.Time{}, false
	}
	if resetAt, ok := codexUsageLimitResetTimeFromHeaders(event, now); ok {
		return resetAt, true
	}
	for _, text := range []string{event.FailBody, event.RawJSON, event.FailSummary} {
		var resetAt time.Time
		found := false
		forEachJSONValue(text, func(decoded any) bool {
			if at, ok := usageLimitResetFromJSON(decoded, now, provider); ok {
				resetAt = at
				found = true
				return true
			}
			return false
		})
		if found {
			return resetAt, true
		}
	}
	return time.Time{}, false
}

func codexUsageLimitResetTimeFromHeaders(event usage.Event, now time.Time) (time.Time, bool) {
	metadata := event.ResponseMetadata
	if metadata == nil && event.ResponseMetadataJSON != "" {
		metadata = usage.ResponseHeaderMetadataFromJSON(event.ResponseMetadataJSON)
	}
	if metadata == nil {
		return time.Time{}, false
	}
	resetAtMS := int64(0)
	if !codexUsageLimitSignalFromHeaders(event, metadata) {
		return time.Time{}, false
	}
	if metadata.Quota != nil {
		resetAtMS = codexQuotaReachedResetAtMS(metadata.Quota)
	}
	if resetAtMS <= 0 && metadata.Errors != nil {
		resetAtMS = metadata.Errors.RetryAfterRecoverAtMS
	}
	if resetAtMS <= 0 {
		return time.Time{}, false
	}
	resetAt := time.UnixMilli(resetAtMS)
	return resetAt, resetAt.After(now)
}

func codexUsageLimitSignalFromHeaders(event usage.Event, metadata *usage.ResponseHeaderMetadata) bool {
	if metadata == nil {
		return false
	}
	if metadata.Quota != nil && strings.TrimSpace(metadata.Quota.RateLimitReachedType) != "" {
		return true
	}
	if metadata.Quota != nil && codexQuotaHasFullWindow(metadata.Quota) {
		return true
	}
	values := []string{event.HeaderErrorKind, event.HeaderErrorCode}
	if metadata.Errors != nil {
		values = append(
			values,
			metadata.Errors.Kind,
			metadata.Errors.Code,
			metadata.Errors.AuthorizationError,
			metadata.Errors.IDEErrorCode,
			metadata.Errors.IDERootErrorCode,
		)
	}
	for _, value := range values {
		if isCodexUsageLimitSignalText(value) {
			return true
		}
	}
	return false
}

func isCodexUsageLimitSignalText(value string) bool {
	normalized := strings.ToLower(strings.TrimSpace(value))
	normalized = strings.ReplaceAll(normalized, "-", "_")
	return strings.Contains(normalized, "usage_limit_reached")
}

func codexQuotaReachedResetAtMS(quota *usage.HeaderQuotaMetadata) int64 {
	if quota == nil {
		return 0
	}
	switch strings.ToLower(strings.TrimSpace(quota.RateLimitReachedType)) {
	case "primary":
		return quotaWindowResetAtMS(quota.Primary)
	case "secondary":
		return quotaWindowResetAtMS(quota.Secondary)
	default:
		return codexQuotaFullWindowResetAtMS(quota)
	}
}

func codexQuotaHasFullWindow(quota *usage.HeaderQuotaMetadata) bool {
	if quota == nil {
		return false
	}
	return quotaWindowUsedAtLimit(quota.Primary) || quotaWindowUsedAtLimit(quota.Secondary)
}

func codexQuotaFullWindowResetAtMS(quota *usage.HeaderQuotaMetadata) int64 {
	if quota == nil {
		return 0
	}
	resetAtMS := int64(0)
	for _, window := range []*usage.HeaderQuotaWindow{quota.Primary, quota.Secondary} {
		if !quotaWindowUsedAtLimit(window) {
			continue
		}
		if reset := quotaWindowResetAtMS(window); reset > resetAtMS {
			resetAtMS = reset
		}
	}
	return resetAtMS
}

func quotaWindowUsedAtLimit(window *usage.HeaderQuotaWindow) bool {
	return window != nil && window.UsedPercent != nil && *window.UsedPercent >= 100
}

func quotaWindowResetAtMS(window *usage.HeaderQuotaWindow) int64 {
	if window == nil {
		return 0
	}
	return window.ResetAtMS
}

// forEachJSONValue decodes every JSON value found in text, calling fn for each.
// It handles concatenated JSON values (e.g. body + headers) and text with
// non-JSON prefixes (HTML, plain text) by scanning for embedded JSON objects.
func forEachJSONValue(text string, fn func(any) bool) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	if tryDecodeAllJSON(text, fn) {
		return
	}
	for i := 0; i < len(text); i++ {
		if text[i] == '{' || text[i] == '[' {
			if tryDecodeAllJSON(text[i:], fn) {
				return
			}
		}
	}
}

func tryDecodeAllJSON(text string, fn func(any) bool) bool {
	decoder := json.NewDecoder(strings.NewReader(text))
	decoder.UseNumber()
	for {
		var decoded any
		if err := decoder.Decode(&decoded); err != nil {
			return false
		}
		if fn(decoded) {
			return true
		}
	}
}

func usageLimitResetFromJSON(value any, now time.Time, provider string) (time.Time, bool) {
	switch typed := value.(type) {
	case map[string]any:
		if provider == "antigravity" && isAntigravityQuotaExhaustedMap(typed) {
			if resetAt, ok := explicitAntigravityResetTime(typed, now); ok {
				return resetAt, true
			}
			return now.Add(10 * time.Minute), true
		}
		if isUsageLimitMap(typed) {
			if resetAt, ok := explicitCodexResetTime(typed, now); ok {
				return resetAt, true
			}
		}
		if rawError, ok := typed["error"]; ok {
			if errorMap, ok := rawError.(map[string]any); ok {
				if provider == "antigravity" && isAntigravityQuotaExhaustedMap(errorMap) {
					if resetAt, ok := explicitAntigravityResetTime(errorMap, now); ok {
						return resetAt, true
					}
					if resetAt, ok := explicitAntigravityResetTime(typed, now); ok {
						return resetAt, true
					}
					return now.Add(10 * time.Minute), true
				}
				if isUsageLimitMap(errorMap) {
					if resetAt, ok := explicitCodexResetTime(errorMap, now); ok {
						return resetAt, true
					}
					if resetAt, ok := explicitCodexResetTime(typed, now); ok {
						return resetAt, true
					}
				}
			}
		}
		for _, child := range typed {
			if resetAt, ok := usageLimitResetFromJSON(child, now, provider); ok {
				return resetAt, true
			}
		}
	case []any:
		for _, child := range typed {
			if resetAt, ok := usageLimitResetFromJSON(child, now, provider); ok {
				return resetAt, true
			}
		}
	}
	return time.Time{}, false
}

func isUsageLimitMap(value map[string]any) bool {
	return strings.EqualFold(strings.TrimSpace(fmt.Sprint(value["type"])), "usage_limit_reached")
}

func isAntigravityQuotaExhaustedMap(value map[string]any) bool {
	status := strings.ToUpper(strings.TrimSpace(fmt.Sprint(value["status"])))
	reason := strings.ToUpper(strings.TrimSpace(fmt.Sprint(value["reason"])))
	code := strings.ToUpper(strings.TrimSpace(fmt.Sprint(value["code"])))
	message := strings.ToLower(strings.TrimSpace(fmt.Sprint(value["message"])))
	domain := strings.ToLower(strings.TrimSpace(fmt.Sprint(value["domain"])))
	return status == "RESOURCE_EXHAUSTED" ||
		reason == "QUOTA_EXHAUSTED" ||
		code == "RESOURCE_EXHAUSTED" ||
		code == "QUOTA_EXHAUSTED" ||
		strings.Contains(domain, "cloudcode-pa.googleapis.com") && strings.Contains(message, "quota")
}

func explicitAntigravityResetTime(value map[string]any, now time.Time) (time.Time, bool) {
	if metadata, ok := value["metadata"].(map[string]any); ok {
		if resetAt, ok := explicitAntigravityResetTime(metadata, now); ok {
			return resetAt, true
		}
	}
	if details, ok := value["details"].([]any); ok {
		for _, detail := range details {
			if detailMap, ok := detail.(map[string]any); ok {
				if resetAt, ok := explicitAntigravityResetTime(detailMap, now); ok {
					return resetAt, true
				}
			}
		}
	}
	for _, key := range []string{"quotaResetTimeStamp", "quotaResetTimestamp", "quota_reset_timestamp", "quota_reset_time_stamp"} {
		if raw, ok := value[key]; ok {
			return parseResetValue(raw, now, false)
		}
	}
	for _, key := range []string{"quotaResetDelay", "quota_reset_delay", "retryDelay", "retry_delay"} {
		if raw, ok := value[key]; ok {
			return parseDurationResetValue(raw, now)
		}
	}
	return time.Time{}, false
}

func explicitCodexResetTime(value map[string]any, now time.Time) (time.Time, bool) {
	for _, key := range []string{"resets_at", "resetsAt"} {
		if raw, ok := value[key]; ok {
			return parseResetValue(raw, now, false)
		}
	}
	for _, key := range []string{"resets_in_seconds", "resetsInSeconds"} {
		if raw, ok := value[key]; ok {
			return parseResetValue(raw, now, true)
		}
	}
	return time.Time{}, false
}

func parseResetValue(value any, now time.Time, relative bool) (time.Time, bool) {
	if value == nil {
		return time.Time{}, false
	}
	switch typed := value.(type) {
	case json.Number:
		return parseResetNumberString(typed.String(), now, relative)
	case float64:
		return resetTimeFromNumber(typed, now, relative)
	case int:
		return resetTimeFromNumber(float64(typed), now, relative)
	case int64:
		return resetTimeFromNumber(float64(typed), now, relative)
	case string:
		return parseResetNumberString(strings.TrimSpace(typed), now, relative)
	default:
		return parseResetNumberString(strings.TrimSpace(fmt.Sprint(typed)), now, relative)
	}
}

func parseDurationResetValue(value any, now time.Time) (time.Time, bool) {
	if value == nil {
		return time.Time{}, false
	}
	text := strings.TrimSpace(fmt.Sprint(value))
	if text == "" || strings.EqualFold(text, "null") {
		return time.Time{}, false
	}
	if parsed, err := time.ParseDuration(text); err == nil {
		return now.Add(parsed), true
	}
	return parseResetNumberString(text, now, true)
}

func parseResetNumberString(text string, now time.Time, relative bool) (time.Time, bool) {
	if text == "" || strings.EqualFold(text, "null") {
		return time.Time{}, false
	}
	if !relative {
		if parsed, ok := parseCommonTime(text); ok {
			return parsed, true
		}
	}
	value, err := strconv.ParseFloat(text, 64)
	if err != nil || value <= 0 {
		return time.Time{}, false
	}
	return resetTimeFromNumber(value, now, relative)
}

func resetTimeFromNumber(value float64, now time.Time, relative bool) (time.Time, bool) {
	if value <= 0 {
		return time.Time{}, false
	}
	if relative {
		return now.Add(time.Duration(value * float64(time.Second))), true
	}
	// Unix milliseconds, e.g. JavaScript timestamps.
	if value > 1_000_000_000_000 {
		return time.UnixMilli(int64(value)), true
	}
	// Unix seconds.
	if value > 1_000_000_000 {
		return time.Unix(int64(value), 0), true
	}
	return time.Time{}, false
}

func parseCommonTime(text string) (time.Time, bool) {
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		time.RFC1123,
		time.RFC1123Z,
		"2006-01-02T15:04:05.000Z07:00",
		"2006-01-02 15:04:05 MST",
		"2006-01-02 15:04:05",
	}
	for _, layout := range layouts {
		if parsed, err := time.Parse(layout, text); err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

func (w *RateLimitAutoDisableWorker) currentAuthFile(ctx context.Context, baseURL string, managementKey string, fileName string, authIndex string) (authFile, bool, error) {
	file, ok, err := cpaauthfiles.New(w.client, quotaAutoDisableActionTimeout).Find(ctx, baseURL, managementKey, fileName, authIndex)
	return file, ok, err
}

func (w *RateLimitAutoDisableWorker) patchAuthFile(ctx context.Context, baseURL string, managementKey string, fileName string, authIndex string, disabled bool) error {
	return cpaauthfiles.New(w.client, quotaAutoDisableActionTimeout).PatchDisabled(ctx, baseURL, managementKey, fileName, disabled, authIndex)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// NormalizeBaseURL is exported for legacy tests.
var NormalizeBaseURL = cpa.NormalizeBaseURL
