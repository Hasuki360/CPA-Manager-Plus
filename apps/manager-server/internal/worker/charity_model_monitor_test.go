package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
)

func TestExtractModelStatusModels(t *testing.T) {
	t.Parallel()

	targets, gpt, claude := extractModelStatusModels(map[string]any{
		"data": map[string]any{
			"models": []any{
				map[string]any{"model_name": "gpt-5.6-sol", "current_status": "yellow"},
				map[string]any{"model_name": "gpt-5.5", "current_status": "green"},
				map[string]any{"model_name": "gpt-5.5-openai-compact", "current_status": "red"},
				map[string]any{"model_name": "claude-sonnet-4", "current_status": "green"},
				map[string]any{"model_name": "gpt-image-2", "current_status": "green"},
			},
		},
	}, []string{"green", "yellow"})

	if containsString(targets, "gpt-5.5-openai-compact") {
		t.Fatal("red status must be excluded")
	}
	if containsString(targets, "gpt-image-2") {
		t.Fatal("image models must be skipped")
	}
	for _, name := range []string{"gpt-5.6-sol", "gpt-5.5", "claude-sonnet-4"} {
		if !containsString(targets, name) {
			t.Fatalf("targets missing %s: %#v", name, targets)
		}
	}
	if !containsString(gpt, "gpt-5.6-sol") || !containsString(gpt, "gpt-5.5") {
		t.Fatalf("gpt = %#v", gpt)
	}
	if !reflect.DeepEqual(claude, []string{"claude-sonnet-4"}) {
		t.Fatalf("claude = %#v", claude)
	}
}

func TestExtractCharityModelsIncludesNonGPT(t *testing.T) {
	t.Parallel()

	targets, gpt, claude := extractCharityModels(map[string]any{
		"data": []any{
			map[string]any{"model_name": "glm-5.2"},
			map[string]any{"model_name": "deepseek-v4-flash"},
			map[string]any{"model_name": "grok-4.5"},
			map[string]any{"model_name": "gpt-5.6-sol"},
			map[string]any{"model_name": "gpt-image-2"},
			map[string]any{"model_name": "claude-sonnet-4"},
		},
	})
	if containsString(targets, "gpt-image-2") {
		t.Fatal("image models must be skipped")
	}
	for _, name := range []string{"glm-5.2", "deepseek-v4-flash", "grok-4.5", "gpt-5.6-sol", "claude-sonnet-4"} {
		if !containsString(targets, name) {
			t.Fatalf("targets missing %s: %#v", name, targets)
		}
	}
	if !reflect.DeepEqual(gpt, []string{"gpt-5.6-sol"}) {
		t.Fatalf("gpt = %#v", gpt)
	}
	if !reflect.DeepEqual(claude, []string{"claude-sonnet-4"}) {
		t.Fatalf("claude = %#v", claude)
	}
}

func TestFetchModelCatalogFallsBackToPricingWhenStatusFails(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/status":
			http.Error(w, "forbidden", http.StatusForbidden)
		case "/pricing":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":[{"model_name":"gpt-5.6-sol"},{"model_name":"glm-5.2"}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	worker := &CharityModelMonitorWorker{client: server.Client()}
	catalog, err := worker.fetchModelCatalog(context.Background(), model.CharityModelMonitorSite{
		StatusURL:  server.URL + "/status",
		PricingURL: server.URL + "/pricing",
	})
	if err != nil {
		t.Fatalf("fetchModelCatalog() error = %v", err)
	}
	if catalog.source != "pricing" {
		t.Fatalf("source = %q, want pricing", catalog.source)
	}
	for _, name := range []string{"gpt-5.6-sol", "glm-5.2"} {
		if !containsString(catalog.targets, name) {
			t.Fatalf("targets missing %s: %#v", name, catalog.targets)
		}
	}
}

func TestNormalizeCharityStateRemovesMuyuanHistory(t *testing.T) {
	t.Parallel()

	state := model.NormalizeCharityModelMonitorState(model.CharityModelMonitorState{
		Sites: map[string]model.CharityModelMonitorSiteState{
			"x666":   {Name: "薄荷公益站"},
			"muyuan": {Name: "君の的公益"},
		},
		LastProviderSync: []model.CharityModelMonitorProviderState{
			{Site: "薄荷公益站", Provider: "https://x666.me/v1"},
			{Site: "君の的公益", Provider: "https://muyuan.do/v1"},
		},
		LastProviderError: []string{"君の的公益: 403", "thin mint error"},
		History: []model.CharityModelMonitorHistoryEntry{{
			ProviderResults: []model.CharityModelMonitorProviderState{{Site: "君の的公益"}},
			ProviderErrors:  []string{"muyuan: 403"},
		}},
	})
	if _, ok := state.Sites["muyuan"]; ok {
		t.Fatal("muyuan site state was not removed")
	}
	if len(state.LastProviderSync) != 1 || len(state.LastProviderError) != 1 {
		t.Fatalf("state was not filtered: %#v", state)
	}
	if len(state.History) != 1 || len(state.History[0].ProviderResults) != 0 || len(state.History[0].ProviderErrors) != 0 {
		t.Fatalf("history was not filtered: %#v", state.History)
	}
}

func TestNormalizeRemovesPersistedMuyuan(t *testing.T) {
	t.Parallel()

	sites := model.NormalizeCharityModelMonitorSites([]model.CharityModelMonitorSite{
		{Key: "x666", Name: "薄荷公益站", Enabled: true},
		{Key: "muyuan", Name: "君の的公益", Enabled: true},
		{Key: "anyrouter", Name: "AnyRouter", Enabled: true},
	})
	if len(sites) != 2 {
		t.Fatalf("sites = %#v", sites)
	}
	for _, site := range sites {
		if site.Key == "muyuan" {
			t.Fatalf("persisted muyuan site was not removed: %#v", sites)
		}
	}
}

func TestFilterModelsByPrefix(t *testing.T) {
	t.Parallel()
	got := filterModelsByPrefix([]string{"gpt-5.6-sol", "glm-5.2", "GPT-5.4"}, "gpt-")
	want := []string{"gpt-5.6-sol", "GPT-5.4"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("filterModelsByPrefix() = %#v, want %#v", got, want)
	}
}

func TestMissingModelsAgainstFullCatalog(t *testing.T) {
	t.Parallel()
	// Custom Codex list can include non-gpt models when catalog is full pricing.
	got := missingModels(
		[]string{"gpt-5.6-sol", "glm-5.2", "deepseek-v4-flash", "deepseek-v4-pro", "grok-4.5"},
		[]string{"glm-5.2", "deepseek-v4-flash", "deepseek-v4-pro", "grok-4.5"},
	)
	want := []string{"gpt-5.6-sol"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("missingModels() = %#v, want %#v", got, want)
	}
	matched := intersectModels(
		[]string{"gpt-5.6-sol", "glm-5.2", "deepseek-v4-flash", "deepseek-v4-pro", "grok-4.5"},
		[]string{"glm-5.2", "deepseek-v4-flash", "deepseek-v4-pro", "grok-4.5"},
	)
	if len(matched) != 4 {
		t.Fatalf("matched = %#v", matched)
	}
}

func TestSetManagedModelExclusionsPartial(t *testing.T) {
	t.Parallel()

	entry := map[string]any{
		"excluded-models": []any{"*", "manual-keep", "o4-mini"},
	}
	changed := setManagedModelExclusions(
		entry,
		false,
		[]string{"o4-mini", "gpt-old"},
		[]string{"gpt-5.4", "o4-mini", "gpt-old"},
	)
	if !changed {
		t.Fatal("expected exclusions to change")
	}
	got := excludedModels(entry["excluded-models"])
	want := []string{"gpt-old", "o4-mini"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("excluded-models = %#v, want %#v", got, want)
	}
	if containsString(got, "*") {
		t.Fatal("partial availability must not keep whole-channel * exclusion")
	}
	if containsString(got, "manual-keep") {
		t.Fatal("custom mode must not preserve unmanaged exclusions (prevents ghost after model edits)")
	}
}

func TestSetManagedModelExclusionsDeletedModelClearsGhost(t *testing.T) {
	t.Parallel()

	entry := map[string]any{
		"excluded-models": []any{"o4-mini"},
	}
	changed := setManagedModelExclusions(
		entry,
		false,
		nil,
		[]string{"gpt-5.4"},
	)
	if !changed {
		t.Fatal("expected ghost exclusion to be cleared")
	}
	if _, ok := entry["excluded-models"]; ok {
		t.Fatalf("expected excluded-models to be cleared after model deletion, got %#v", entry["excluded-models"])
	}
}

func TestSetManagedModelExclusionsFullDisable(t *testing.T) {
	t.Parallel()

	entry := map[string]any{
		"excluded-models": []any{"o4-mini", "manual-keep"},
	}
	changed := setManagedModelExclusions(
		entry,
		true,
		[]string{"o4-mini", "gpt-5.4"},
		[]string{"gpt-5.4", "o4-mini"},
	)
	if !changed {
		t.Fatal("expected exclusions to change")
	}
	got := excludedModels(entry["excluded-models"])
	want := []string{"*"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("excluded-models = %#v, want %#v", got, want)
	}
}

func TestSetManagedModelExclusionsAllAvailable(t *testing.T) {
	t.Parallel()

	entry := map[string]any{
		"excluded-models": []any{"*", "o4-mini"},
	}
	changed := setManagedModelExclusions(
		entry,
		false,
		nil,
		[]string{"gpt-5.4", "o4-mini"},
	)
	if !changed {
		t.Fatal("expected exclusions to change")
	}
	if _, ok := entry["excluded-models"]; ok {
		t.Fatalf("expected excluded-models to be cleared, got %#v", entry["excluded-models"])
	}
}

func TestSetManagedModelExclusionsAddedMissingModel(t *testing.T) {
	t.Parallel()

	entry := map[string]any{}
	changed := setManagedModelExclusions(
		entry,
		false,
		[]string{"new-bad-model"},
		[]string{"gpt-5.4", "new-bad-model"},
	)
	if !changed {
		t.Fatal("expected exclusions to change")
	}
	got := excludedModels(entry["excluded-models"])
	want := []string{"new-bad-model"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("excluded-models = %#v, want %#v", got, want)
	}
}

func TestAppendCharityHistoryKeepsLatest(t *testing.T) {
	t.Parallel()

	var history []model.CharityModelMonitorHistoryEntry
	for i := 0; i < model.MaxCharityModelMonitorHistory+3; i++ {
		history = appendCharityHistory(history, model.CharityModelMonitorHistoryEntry{
			CheckedAt: fmt.Sprintf("t-%02d", i),
		})
	}
	if len(history) != model.MaxCharityModelMonitorHistory {
		t.Fatalf("history len = %d, want %d", len(history), model.MaxCharityModelMonitorHistory)
	}
	if history[0].CheckedAt != "t-03" {
		t.Fatalf("oldest kept = %q, want t-03", history[0].CheckedAt)
	}
	if history[len(history)-1].CheckedAt != "t-14" {
		t.Fatalf("newest = %q, want t-14", history[len(history)-1].CheckedAt)
	}
}

func TestJoinModelsForLog(t *testing.T) {
	t.Parallel()
	if got := joinModelsForLog(nil); got != "-" {
		t.Fatalf("empty = %q", got)
	}
	values := []string{"a", "b", "c", "d", "e", "f", "g", "h", "i"}
	got := joinModelsForLog(values)
	if !strings.Contains(got, "...(+1)") {
		t.Fatalf("truncated log = %q", got)
	}
}

func TestDefaultCharityModelMonitorSitesWildcardHeadersOnly(t *testing.T) {
	t.Parallel()

	sites := model.NormalizeCharityModelMonitorSites(model.DefaultCharityModelMonitorSites())
	if len(sites) != 1 {
		t.Fatalf("sites = %#v, want single all-codex wildcard site", sites)
	}
	site := sites[0]
	if site.Key != "all-codex" || !site.Enabled {
		t.Fatalf("site = %#v, want enabled all-codex", site)
	}
	if site.CodexBaseURL != "*" || site.CodexProviderSection != "codex-api-key" {
		t.Fatalf("codex target = %s %s, want codex-api-key *", site.CodexProviderSection, site.CodexBaseURL)
	}
	if !site.SyncCodexHeadersOnly {
		t.Fatal("default site must be headers-only so channel switches are untouched")
	}
	if site.ClaudeBaseURL != "" || site.MonitorGPT || site.MonitorClaude {
		t.Fatalf("default site must not monitor models: %#v", site)
	}
}

func newCharityCPAServer(t *testing.T, captured *[]any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut && r.URL.Path == "/v0/management/codex-api-key" {
			body, err := io.ReadAll(r.Body)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			var entries []any
			if err := json.Unmarshal(body, &entries); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			*captured = entries
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte("{}"))
			return
		}
		http.NotFound(w, r)
	}))
}

func TestSyncProviderWildcardUpdatesAllCodexEntries(t *testing.T) {
	t.Parallel()

	var captured []any
	server := newCharityCPAServer(t, &captured)
	defer server.Close()

	worker := &CharityModelMonitorWorker{client: server.Client()}
	cfg := CharityModelMonitorConfig{CPAUpstreamURL: server.URL, ManagementKey: "k"}
	configData := map[string]any{
		"codex-api-key": []any{
			map[string]any{
				"api-key":  "sk-a",
				"base-url": "https://a.example/v1",
				"headers": map[string]any{
					"User-Agent": "codex_cli_rs/0.1.0 (Old OS; x64)",
					"X-Custom":   "keep-me",
				},
			},
			map[string]any{
				"api-key":         "sk-b",
				"base-url":        "https://b.example/v1",
				"excluded-models": []any{"*"},
			},
			map[string]any{
				"api-key":  "sk-c",
				"base-url": "https://c.example/v1",
				"priority": 9,
			},
		},
		"openai-compatibility": []any{
			map[string]any{"base-url": "https://other.example/v1"},
		},
	}
	site := model.CharityModelMonitorSite{
		Key:                  "all-codex",
		Name:                 "全部 Codex 提供商",
		Enabled:              true,
		CodexProviderSection: "codex-api-key",
		CodexBaseURL:         "*",
		SyncCodexHeadersOnly: true,
	}

	result, err := worker.syncProvider(context.Background(), cfg, configData, site, "Codex", site.CodexProviderSection, site.CodexBaseURL, nil, codexProviderHeaders("0.99.0"), true)
	if err != nil {
		t.Fatalf("syncProvider() error = %v", err)
	}
	if !result.Changed || !result.HeadersChanged || result.SwitchChanged {
		t.Fatalf("result = %#v, want headers-only change", result)
	}
	if len(captured) != 3 {
		t.Fatalf("PUT entries = %d, want 3 (every codex-api-key entry)", len(captured))
	}
	for _, item := range captured {
		entry, _ := item.(map[string]any)
		headers, _ := entry["headers"].(map[string]any)
		agent, _ := headers["User-Agent"].(string)
		if !strings.Contains(agent, "codex_cli_rs/0.99.0") {
			t.Fatalf("entry %v User-Agent = %q, want 0.99.0", entry["base-url"], agent)
		}
		if headers["originator"] != "codex_cli_rs" || headers["x-openai-subagent"] != "codex-mcp-client" {
			t.Fatalf("entry %v headers = %#v", entry["base-url"], headers)
		}
		if _, ok := entry["auth-index"]; ok {
			t.Fatalf("entry %v must drop auth-index", entry["base-url"])
		}
	}
	first, _ := captured[0].(map[string]any)
	firstHeaders, _ := first["headers"].(map[string]any)
	if firstHeaders["X-Custom"] != "keep-me" {
		t.Fatalf("custom headers must be preserved, got %#v", firstHeaders)
	}
	second, _ := captured[1].(map[string]any)
	excluded, ok := second["excluded-models"].([]any)
	if !ok || len(excluded) != 1 || excluded[0] != "*" {
		t.Fatalf("headers-only mode must not touch channel switches, got %#v", second["excluded-models"])
	}
}

func TestSyncProviderExactURLMatchesSingleEntry(t *testing.T) {
	t.Parallel()

	var captured []any
	server := newCharityCPAServer(t, &captured)
	defer server.Close()

	worker := &CharityModelMonitorWorker{client: server.Client()}
	cfg := CharityModelMonitorConfig{CPAUpstreamURL: server.URL, ManagementKey: "k"}
	configData := map[string]any{
		"codex-api-key": []any{
			map[string]any{"api-key": "sk-a", "base-url": "https://a.example/v1"},
			map[string]any{"api-key": "sk-b", "base-url": "https://b.example/v1/"},
		},
	}
	site := model.CharityModelMonitorSite{
		Key:                  "a",
		Name:                 "A",
		Enabled:              true,
		CodexProviderSection: "codex-api-key",
		CodexBaseURL:         "https://a.example/v1",
		SyncCodexHeadersOnly: true,
	}

	result, err := worker.syncProvider(context.Background(), cfg, configData, site, "Codex", site.CodexProviderSection, site.CodexBaseURL, nil, codexProviderHeaders("0.99.0"), true)
	if err != nil {
		t.Fatalf("syncProvider() error = %v", err)
	}
	if !result.Changed {
		t.Fatalf("result = %#v, want change", result)
	}
	if len(captured) != 2 {
		t.Fatalf("PUT entries = %d, want 2 (whole section rewrite)", len(captured))
	}
	first, _ := captured[0].(map[string]any)
	if _, ok := first["headers"]; !ok {
		t.Fatalf("matched entry must gain headers, got %#v", first)
	}
	second, _ := captured[1].(map[string]any)
	if _, ok := second["headers"]; ok {
		t.Fatalf("unmatched entry must keep no headers, got %#v", second)
	}
}
