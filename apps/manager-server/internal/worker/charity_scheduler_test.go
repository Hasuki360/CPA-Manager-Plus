package worker

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
)

func TestCharityReloadDuringRunUsesLatestTargets(t *testing.T) {
	st, err := store.Open(t.TempDir() + "/usage.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if _, err := st.SaveCharityModelMonitorState(ctx, model.CharityModelMonitorState{
		LastCodexCLIVersion: "0.153.4", LastCodexVersionChecked: time.Now().UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	defer unblock()
	var gets atomic.Int32
	written := make(chan []map[string]any, 8)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v0/management/config":
			if gets.Add(1) == 1 {
				close(started)
				select {
				case <-release:
				case <-r.Context().Done():
					return
				}
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"codex-api-key": []map[string]any{
				{"base-url": "https://a.example/v1", "headers": map[string]any{}},
				{"base-url": "https://b.example/v1", "headers": map[string]any{}},
			}})
		case r.Method == http.MethodPut && r.URL.Path == "/v0/management/codex-api-key":
			var entries []map[string]any
			if err := json.NewDecoder(r.Body).Decode(&entries); err != nil {
				http.Error(w, "invalid test request", http.StatusBadRequest)
				return
			}
			written <- entries
			_, _ = w.Write([]byte("{}"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	cfg := CharityModelMonitorConfig{
		Enabled: true, IntervalMinutes: 1440, CPAUpstreamURL: server.URL, ManagementKey: "test",
		Sites: []model.CharityModelMonitorSite{{Key: "a", Name: "A", Enabled: true,
			CodexBaseURL: "https://a.example/v1", SyncCodexHeadersOnly: true}},
	}
	worker := NewCharityModelMonitorWorker(st, cfg)
	worker.Start(ctx)
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("initial cycle did not start")
	}
	cfg.Sites = []model.CharityModelMonitorSite{{Key: "b", Name: "B", Enabled: true,
		CodexBaseURL: "https://b.example/v1", SyncCodexHeadersOnly: true}}
	requestCtx, requestCancel := context.WithCancel(context.Background())
	requestCancel()
	worker.UpdateConfig(requestCtx, cfg)
	// The previous inventory must not be written after a target change. The
	// canceled HTTP request context must not cancel the new service-owned cycle.
	unblock()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case entries := <-written:
			if len(entries) != 2 {
				t.Fatalf("provider entries = %d", len(entries))
			}
			first, _ := entries[0]["headers"].(map[string]any)
			second, _ := entries[1]["headers"].(map[string]any)
			if first["User-Agent"] != nil {
				t.Fatal("superseded target A received a stale write")
			}
			if second["User-Agent"] == nil {
				t.Fatal("latest target B was not synchronized")
			}
			cancel()
			return
		case <-deadline:
			t.Fatal("reload was dropped instead of running the latest targets")
		}
	}
}
