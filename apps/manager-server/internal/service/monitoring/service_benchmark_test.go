package monitoring

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

func BenchmarkUsageAnalyticsIncludeProfiles(b *testing.B) {
	db, err := store.Open(filepath.Join(b.TempDir(), "usage.sqlite"))
	if err != nil {
		b.Fatalf("open store: %v", err)
	}
	b.Cleanup(func() { _ = db.Close() })

	ctx := context.Background()
	fromMS := int64(1_800_000_000_000)
	toMS := fromMS + 30*24*60*60*1000
	insertMonitoringBenchmarkEvents(b, ctx, db, fromMS, toMS, 100_000)
	service := New(db)

	request := func(include Include) Request {
		return Request{
			FromMS:   fromMS,
			ToMS:     toMS,
			NowMS:    toMS,
			TimeZone: "UTC",
			Include:  include,
		}
	}
	selectors := request(Include{FilterOptions: true, FilterSelectors: true})
	profiles := []struct {
		name     string
		requests []Request
	}{
		{
			name: "legacy_full",
			requests: []Request{request(Include{
				Summary:            true,
				SummaryComparison:  true,
				Timeline:           true,
				ModelStats:         true,
				ChannelShare:       true,
				APIKeyStats:        true,
				CredentialStats:    true,
				CredentialTimeline: true,
				FilterOptions:      true,
				Heatmap:            true,
				AnomalyPoints:      true,
				Granularity:        "day",
			})},
		},
		{
			name: "overview_initial",
			requests: []Request{
				request(Include{
					Summary:           true,
					SummaryComparison: true,
					Timeline:          true,
					ModelStats:        true,
					ChannelShare:      true,
					APIKeyStats:       true,
					AnomalyPoints:     true,
					Granularity:       "day",
				}),
				selectors,
			},
		},
		{
			name: "overview_tab_request",
			requests: []Request{request(Include{
				Summary:           true,
				SummaryComparison: true,
				Timeline:          true,
				ModelStats:        true,
				ChannelShare:      true,
				APIKeyStats:       true,
				AnomalyPoints:     true,
				Granularity:       "day",
			})},
		},
		{
			name: "trends_tab_request",
			requests: []Request{request(Include{
				Summary:           true,
				SummaryComparison: true,
				Timeline:          true,
				ModelStats:        true,
				APIKeyStats:       true,
				AnomalyPoints:     true,
				Granularity:       "day",
			})},
		},
		{
			name: "models_tab_request",
			requests: []Request{request(Include{
				Summary:     true,
				Timeline:    true,
				ModelStats:  true,
				APIKeyStats: true,
				Granularity: "day",
			})},
		},
		{
			name: "api_keys_tab_request",
			requests: []Request{request(Include{
				Summary:     true,
				APIKeyStats: true,
				Granularity: "day",
			})},
		},
		{
			name: "credentials_tab_request",
			requests: []Request{request(Include{
				Summary:            true,
				CredentialStats:    true,
				CredentialTimeline: true,
				Granularity:        "day",
			})},
		},
		{
			name: "heatmap_tab_request",
			requests: []Request{request(Include{
				Summary:     true,
				Heatmap:     true,
				Granularity: "day",
			})},
		},
		{name: "filter_selectors", requests: []Request{selectors}},
	}

	for _, profile := range profiles {
		b.Run(profile.name, func(b *testing.B) {
			b.ReportAllocs()
			for range b.N {
				for _, req := range profile.requests {
					if _, err := service.Analytics(ctx, req); err != nil {
						b.Fatalf("analytics: %v", err)
					}
				}
			}
		})
	}
}

func insertMonitoringBenchmarkEvents(b *testing.B, ctx context.Context, db *store.Store, fromMS, toMS int64, count int) {
	b.Helper()
	const batchSize = 1000
	stepMS := max(int64(1), (toMS-fromMS)/int64(count))
	latencyMS := int64(250)
	ttftMS := int64(50)
	for offset := 0; offset < count; offset += batchSize {
		end := min(offset+batchSize, count)
		events := make([]usage.Event, 0, end-offset)
		for index := offset; index < end; index++ {
			timestampMS := fromMS + int64(index)*stepMS
			authIndex := fmt.Sprintf("auth-%03d", index%100)
			event := monitoringEvent(
				fmt.Sprintf("analytics-benchmark-%06d", index),
				timestampMS,
				fmt.Sprintf("gpt-%02d", index%12),
				authIndex,
				fmt.Sprintf("source-%03d", index%100),
				index%20 == 0,
				int64(100+index%300),
				int64(50+index%150),
				int64(index%40),
				int64(index%80),
				int64(150+index%500),
				&latencyMS,
			)
			event.APIKeyHash = fmt.Sprintf("key-%03d", index%50)
			event.AccountSnapshot = fmt.Sprintf("account-%03d@example.com", index%100)
			event.AuthLabelSnapshot = fmt.Sprintf("Account %03d", index%100)
			event.AuthFileSnapshot = fmt.Sprintf("account-%03d.json", index%100)
			event.AuthProviderSnapshot = []string{"codex", "claude", "gemini"}[index%3]
			event.AuthProjectIDSnapshot = fmt.Sprintf("project-%02d", index%10)
			event.ServiceTier = []string{"", "default", "priority"}[index%3]
			event.TTFTMS = &ttftMS
			events = append(events, event)
		}
		if _, err := db.InsertEvents(ctx, events); err != nil {
			b.Fatalf("insert benchmark events: %v", err)
		}
	}
}
