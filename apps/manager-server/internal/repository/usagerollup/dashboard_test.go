package usagerollup

import (
	"context"
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/repository/usageevent"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

func TestCatchUpDashboardHourlyAggregatesByCheckpoint(t *testing.T) {
	db := newRollupTestDB(t)
	ctx := context.Background()
	events := usageevent.New(db)
	repo := New(db)
	baseMS := int64(1_700_000_000_000)
	firstHour := baseMS - baseMS%dashboardHourMS
	latency100 := int64(100)
	latency200 := int64(200)

	first := rollupTestEvent("dashboard-hourly-1", firstHour+1_000, "alias-a", "resolved-a", "alice@example.com", "", "auth-a", false, 100, 50, 10, 40, 10, 5, 165)
	first.LatencyMS = &latency100
	zero := rollupTestEvent("dashboard-hourly-zero", firstHour+2_000, "alias-a", "resolved-a", "alice@example.com", "", "auth-a", false, 0, 0, 0, 0, 0, 0, 0)
	failed := rollupTestEvent("dashboard-hourly-failed", firstHour+3_000, "alias-a", "resolved-a", "alice@example.com", "", "auth-a", true, 1, 2, 0, 0, 0, 0, 3)
	failed.LatencyMS = &latency200
	priority := rollupTestEvent("dashboard-hourly-priority", firstHour+dashboardHourMS+1_000, "alias-a", "resolved-a", "alice@example.com", "", "auth-a", false, 5, 6, 0, 0, 0, 0, 11)
	priority.ServiceTier = "priority"

	if _, err := events.InsertBatch(ctx, []usage.Event{first, zero, failed, priority}); err != nil {
		t.Fatalf("insert events: %v", err)
	}

	result, err := repo.CatchUpDashboardHourly(ctx, 2, baseMS+10_000)
	if err != nil {
		t.Fatalf("first catch-up: %v", err)
	}
	if result.Processed != 2 || !result.Pending {
		t.Fatalf("first catch-up = %#v", result)
	}
	result, err = repo.CatchUpDashboardHourly(ctx, 10, baseMS+11_000)
	if err != nil {
		t.Fatalf("second catch-up: %v", err)
	}
	if result.Processed != 2 || result.Pending || result.LastEventID != 4 {
		t.Fatalf("second catch-up = %#v", result)
	}
	result, err = repo.CatchUpDashboardHourly(ctx, 10, baseMS+12_000)
	if err != nil {
		t.Fatalf("third catch-up: %v", err)
	}
	if result.Processed != 0 || result.Pending {
		t.Fatalf("third catch-up = %#v", result)
	}

	rows, err := repo.DashboardHourlyRows(ctx, firstHour, firstHour+2*dashboardHourMS)
	if err != nil {
		t.Fatalf("query rows: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %#v", rows)
	}
	standard := rows[0]
	if standard.BucketMS != firstHour || standard.Calls != 3 || standard.SuccessCalls != 2 || standard.FailureCalls != 1 {
		t.Fatalf("standard counts = %#v", standard)
	}
	if standard.InputTokens != 101 || standard.OutputTokens != 52 || standard.CachedTokens != 25 || standard.TotalTokens != 168 {
		t.Fatalf("standard tokens = %#v", standard)
	}
	if standard.LatencySumMS != 300 || standard.LatencySamples != 2 || standard.ZeroTokenCalls != 1 {
		t.Fatalf("standard latency/zero = %#v", standard)
	}
	if rows[1].BucketMS != firstHour+dashboardHourMS || rows[1].ServiceTier != "priority" || rows[1].Calls != 1 {
		t.Fatalf("priority row = %#v", rows[1])
	}

	checkpoint, err := repo.Checkpoint(ctx, DashboardHourlyCheckpointName)
	if err != nil {
		t.Fatalf("checkpoint: %v", err)
	}
	if checkpoint.LastEventID != 4 {
		t.Fatalf("checkpoint = %#v", checkpoint)
	}
}

func TestCatchUpDashboardHourlyFailureDoesNotAdvanceCheckpoint(t *testing.T) {
	db := newRollupTestDB(t)
	ctx := context.Background()
	events := usageevent.New(db)
	repo := New(db)

	if _, err := events.InsertBatch(ctx, []usage.Event{
		rollupTestEvent("dashboard-hourly-failure", 1_700_000_001_000, "gpt-a", "", "alice@example.com", "", "auth-a", false, 1, 1, 0, 0, 0, 0, 2),
	}); err != nil {
		t.Fatalf("insert events: %v", err)
	}
	if _, err := db.Exec(`drop table usage_dashboard_hourly_rollups`); err != nil {
		t.Fatalf("drop table: %v", err)
	}
	if _, err := repo.CatchUpDashboardHourly(ctx, 10, 1_700_000_010_000); err == nil {
		t.Fatalf("expected catch-up to fail")
	}
	checkpoint, err := repo.Checkpoint(ctx, DashboardHourlyCheckpointName)
	if err != nil {
		t.Fatalf("checkpoint: %v", err)
	}
	if checkpoint.LastEventID != 0 {
		t.Fatalf("checkpoint advanced after failure: %#v", checkpoint)
	}
}
