package dashboard

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

func BenchmarkDashboardTodayMetrics(b *testing.B) {
	db, err := store.Open(filepath.Join(b.TempDir(), "usage.sqlite"))
	if err != nil {
		b.Fatalf("open store: %v", err)
	}
	b.Cleanup(func() { _ = db.Close() })
	ctx := context.Background()
	todayStart := int64(1_800_000_000_000)
	nowMS := todayStart + 24*hourWindowMs
	insertDashboardBenchmarkEvents(b, ctx, db, todayStart, 100_000)
	service := New(db)

	b.Run("raw_events_100k", func(b *testing.B) {
		b.ReportAllocs()
		for index := 0; index < b.N; index++ {
			if _, _, _, _, err := service.loadTodayMetrics(ctx, todayStart, nowMS, 5); err != nil {
				b.Fatalf("load raw metrics: %v", err)
			}
		}
	})

	for {
		result, err := db.CatchUpDashboardHourlyRollups(ctx, 5_000, time.Now().UnixMilli())
		if err != nil {
			b.Fatalf("catch up dashboard rollup: %v", err)
		}
		if !result.Pending {
			break
		}
	}

	b.Run("hourly_rollup_100k", func(b *testing.B) {
		b.ReportAllocs()
		for index := 0; index < b.N; index++ {
			if _, _, _, _, err := service.loadTodayMetrics(ctx, todayStart, nowMS, 5); err != nil {
				b.Fatalf("load rollup metrics: %v", err)
			}
		}
	})
}

func insertDashboardBenchmarkEvents(b *testing.B, ctx context.Context, db *store.Store, todayStart int64, count int) {
	b.Helper()
	const batchSize = 1_000
	for start := 0; start < count; start += batchSize {
		end := min(start+batchSize, count)
		events := make([]usage.Event, 0, end-start)
		for index := start; index < end; index++ {
			timestampMS := todayStart + int64(index%86_400)*1000
			model := fmt.Sprintf("benchmark-model-%02d", index%12)
			latency := int64(50 + index%500)
			event := dashboardEvent(
				fmt.Sprintf("dashboard-benchmark-%06d", index),
				timestampMS,
				model,
				index%20 == 0,
				int64(100+index%1_000),
				int64(50+index%500),
				int64(index%100),
				int64(index%200),
				0,
				int64(200+index%2_000),
				&latency,
			)
			if index%3 == 0 {
				event.ResolvedModel = model + "-resolved"
			}
			if index%7 == 0 {
				event.ServiceTier = "priority"
			}
			events = append(events, event)
		}
		if _, err := db.InsertEvents(ctx, events); err != nil {
			b.Fatalf("insert benchmark events: %v", err)
		}
	}
}
