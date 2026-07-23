package worker

import (
	"context"
	"fmt"
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
