package usageevent

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	sqliterepo "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/repository/sqlite"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

func TestLatencyPercentilesUseNearestRankAcrossSummaryAndBuckets(t *testing.T) {
	db, err := sqliterepo.Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	repo := New(db)
	base := time.Date(2026, time.January, 1, 10, 0, 0, 0, time.UTC)
	events := make([]usage.Event, 0, 40)
	for hour := 0; hour < 2; hour++ {
		for sample := int64(1); sample <= 20; sample++ {
			latency := sample + int64(hour*100)
			ttft := latency * 2
			timestamp := base.Add(time.Duration(hour) * time.Hour).Add(time.Duration(sample) * time.Second)
			events = append(events, usage.Event{
				EventHash:   fmt.Sprintf("%d-%d", hour, sample),
				TimestampMS: timestamp.UnixMilli(),
				Timestamp:   timestamp.Format(time.RFC3339Nano),
				Model:       "gpt-test",
				LatencyMS:   &latency,
				TTFTMS:      &ttft,
				CreatedAtMS: timestamp.UnixMilli(),
			})
		}
	}
	if _, err := repo.InsertBatch(context.Background(), events); err != nil {
		t.Fatalf("insert events: %v", err)
	}

	filter := AnalyticsFilter{
		FromMS: base.UnixMilli(),
		ToMS:   base.Add(2 * time.Hour).UnixMilli(),
	}
	summary, err := repo.LatencySummaryWithFilter(context.Background(), filter)
	if err != nil {
		t.Fatalf("latency summary: %v", err)
	}
	if !summary.P95LatencyMS.Valid || summary.P95LatencyMS.Float64 != 118 {
		t.Fatalf("summary latency p95 = %#v, want 118", summary.P95LatencyMS)
	}
	if !summary.P95TTFTMS.Valid || summary.P95TTFTMS.Float64 != 236 {
		t.Fatalf("summary ttft p95 = %#v, want 236", summary.P95TTFTMS)
	}

	points, err := repo.LatencyPercentilesWithFilter(context.Background(), filter, "hour", time.UTC)
	if err != nil {
		t.Fatalf("latency percentiles: %v", err)
	}
	if len(points) != 2 {
		t.Fatalf("points = %#v", points)
	}
	if points[0].P95LatencyMS.Float64 != 19 || points[0].P95TTFTMS.Float64 != 38 {
		t.Fatalf("first bucket = %#v", points[0])
	}
	if points[1].P95LatencyMS.Float64 != 119 || points[1].P95TTFTMS.Float64 != 238 {
		t.Fatalf("second bucket = %#v", points[1])
	}
}

func TestLatencySummaryReturnsInvalidPercentilesWithoutSamples(t *testing.T) {
	db, err := sqliterepo.Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	summary, err := New(db).LatencySummaryWithFilter(context.Background(), AnalyticsFilter{})
	if err != nil {
		t.Fatalf("latency summary: %v", err)
	}
	if summary.P95LatencyMS.Valid || summary.P95TTFTMS.Valid {
		t.Fatalf("summary = %#v", summary)
	}
}
