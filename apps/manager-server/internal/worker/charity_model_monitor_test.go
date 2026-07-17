package worker

import (
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
)

func TestMissingModels(t *testing.T) {
	t.Parallel()

	got := missingModels(
		[]string{"gpt-5.4", "o4-mini", "gpt-5.3-codex"},
		[]string{"GPT-5.4", "gpt-5.3-codex"},
	)
	want := []string{"o4-mini"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("missingModels() = %#v, want %#v", got, want)
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
