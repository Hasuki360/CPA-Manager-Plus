package codexinspection

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	collectorpkg "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/collector"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/config"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/collector"
	managerconfigsvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/managerconfig"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/testutil"
)

func TestRunPersistsLogsResultsAndDetail(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/auth-files" && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"files":[{"name":"auth-a.json","auth_index":"auth-1","provider":"codex","account":"alice@example.com","status":"ok","state":"ready"}]}`))
		case r.URL.Path == "/api-call" && r.Method == http.MethodPost:
			_, _ = w.Write([]byte(`{"status_code":401,"body":{"message":"unauthorized"}}`))
		case strings.HasPrefix(r.URL.Path, "/auth-files") && r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(upstream.Close)

	db := newCodexInspectionTestStore(t)
	if err := db.SaveManagerConfig(context.Background(), newCodexInspectionManagerConfig(upstream.URL)); err != nil {
		t.Fatalf("save manager config: %v", err)
	}
	svc := newCodexInspectionTestService(t, db)

	result, err := svc.Run(context.Background(), RunRequest{
		TriggerType: "manual",
		TriggerKey:  "manual",
	})
	if err != nil {
		t.Fatalf("run inspection: %v", err)
	}
	if result.Run.Status != model.CodexInspectionStatusCompleted {
		t.Fatalf("run status = %q", result.Run.Status)
	}
	if len(result.Results) != 1 {
		t.Fatalf("results = %#v", result.Results)
	}
	if result.Results[0].RunID != result.Run.ID {
		t.Fatalf("result run id = %d, want %d", result.Results[0].RunID, result.Run.ID)
	}
	if result.Results[0].Action != "delete" {
		t.Fatalf("result action = %q", result.Results[0].Action)
	}
	if len(result.Logs) == 0 {
		t.Fatal("expected persisted logs")
	}
	foundStart := false
	for _, logEntry := range result.Logs {
		if logEntry.Message == "Codex 巡检开始" {
			foundStart = true
			if logEntry.Detail == nil {
				t.Fatalf("start log detail is nil: %#v", logEntry)
			}
			break
		}
	}
	if !foundStart {
		t.Fatalf("logs = %#v", result.Logs)
	}
}

func TestRunDoesNotAutoEnableRecoveredDisabledAccount(t *testing.T) {
	var patchCalled bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/auth-files" && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"files":[{"name":"auth-a.json","auth_index":"auth-1","provider":"codex","account":"alice@example.com","disabled":true,"status":"ok","state":"ready"}]}`))
		case r.URL.Path == "/api-call" && r.Method == http.MethodPost:
			_, _ = w.Write([]byte(`{"status_code":200,"body":{"ok":true}}`))
		case strings.HasPrefix(r.URL.Path, "/auth-files") && r.Method == http.MethodPatch:
			patchCalled = true
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(upstream.Close)

	db := newCodexInspectionTestStore(t)
	if err := db.SaveManagerConfig(context.Background(), newCodexInspectionManagerConfig(upstream.URL)); err != nil {
		t.Fatalf("save manager config: %v", err)
	}
	svc := newCodexInspectionTestService(t, db)

	result, err := svc.Run(context.Background(), RunRequest{
		TriggerType: "manual",
		TriggerKey:  "manual",
	})
	if err != nil {
		t.Fatalf("run inspection: %v", err)
	}
	if result.Run.EnableCount != 1 {
		t.Fatalf("enable count = %d, want 1", result.Run.EnableCount)
	}
	if patchCalled {
		t.Fatal("server inspection auto-executed enable action")
	}
}

func TestRunFallsBackToManagementAPICallPath(t *testing.T) {
	var legacyAPICalls int
	var managementAPICalls int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/auth-files" && r.Method == http.MethodGet:
			http.NotFound(w, r)
		case r.URL.Path == "/v0/management/auth-files" && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"files":[{"name":"auth-a.json","auth_index":"auth-1","provider":"codex","account":"alice@example.com","status":"ok","state":"ready"}]}`))
		case r.URL.Path == "/api-call" && r.Method == http.MethodPost:
			legacyAPICalls++
			http.NotFound(w, r)
		case r.URL.Path == "/v0/management/api-call" && r.Method == http.MethodPost:
			managementAPICalls++
			_, _ = w.Write([]byte(`{"status_code":200,"body":{"ok":true}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(upstream.Close)

	db := newCodexInspectionTestStore(t)
	if err := db.SaveManagerConfig(context.Background(), newCodexInspectionManagerConfig(upstream.URL)); err != nil {
		t.Fatalf("save manager config: %v", err)
	}
	svc := newCodexInspectionTestService(t, db)

	result, err := svc.Run(context.Background(), RunRequest{
		TriggerType: "manual",
		TriggerKey:  "manual",
	})
	if err != nil {
		t.Fatalf("run inspection: %v", err)
	}
	if result.Run.Status != model.CodexInspectionStatusCompleted {
		t.Fatalf("run status = %q", result.Run.Status)
	}
	if legacyAPICalls != 1 || managementAPICalls != 1 {
		t.Fatalf("api-call counts legacy=%d management=%d, want 1/1", legacyAPICalls, managementAPICalls)
	}
}

func TestRunSendsDirectCodexAccountIDHeader(t *testing.T) {
	var accountIDHeader string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/auth-files" && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"files":[{"name":"auth-a.json","auth_index":"auth-1","provider":"codex","account_id":"acct-direct","account":"alice@example.com","status":"ok","state":"ready"}]}`))
		case r.URL.Path == "/api-call" && r.Method == http.MethodPost:
			var payload struct {
				Header map[string]string `json:"header"`
			}
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatalf("decode api-call payload: %v", err)
			}
			accountIDHeader = payload.Header["Chatgpt-Account-Id"]
			_, _ = w.Write([]byte(`{"status_code":200,"body":{"ok":true}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(upstream.Close)

	db := newCodexInspectionTestStore(t)
	if err := db.SaveManagerConfig(context.Background(), newCodexInspectionManagerConfig(upstream.URL)); err != nil {
		t.Fatalf("save manager config: %v", err)
	}
	svc := newCodexInspectionTestService(t, db)

	if _, err := svc.Run(context.Background(), RunRequest{
		TriggerType: "manual",
		TriggerKey:  "manual",
	}); err != nil {
		t.Fatalf("run inspection: %v", err)
	}
	if accountIDHeader != "acct-direct" {
		t.Fatalf("Chatgpt-Account-Id = %q, want %q", accountIDHeader, "acct-direct")
	}
}

func TestRunFallsBackToManagementAuthFileActionPath(t *testing.T) {
	var legacyDeleteCalls int
	var managementDeleteCalls int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/auth-files" && r.Method == http.MethodGet:
			http.NotFound(w, r)
		case r.URL.Path == "/v0/management/auth-files" && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"files":[{"name":"auth-a.json","auth_index":"auth-1","provider":"codex","account":"alice@example.com","status":"ok","state":"ready"}]}`))
		case r.URL.Path == "/api-call" && r.Method == http.MethodPost:
			http.NotFound(w, r)
		case r.URL.Path == "/v0/management/api-call" && r.Method == http.MethodPost:
			_, _ = w.Write([]byte(`{"status_code":401,"body":{"message":"unauthorized"}}`))
		case r.URL.Path == "/auth-files" && r.Method == http.MethodDelete:
			legacyDeleteCalls++
			http.NotFound(w, r)
		case r.URL.Path == "/v0/management/auth-files" && r.Method == http.MethodDelete:
			managementDeleteCalls++
			if r.URL.Query().Get("name") != "auth-a.json" {
				t.Fatalf("delete name = %q, want auth-a.json", r.URL.Query().Get("name"))
			}
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(upstream.Close)

	db := newCodexInspectionTestStore(t)
	if err := db.SaveManagerConfig(context.Background(), newCodexInspectionManagerConfig(upstream.URL)); err != nil {
		t.Fatalf("save manager config: %v", err)
	}
	svc := newCodexInspectionTestService(t, db)

	result, err := svc.Run(context.Background(), RunRequest{
		TriggerType: "manual",
		TriggerKey:  "manual",
	})
	if err != nil {
		t.Fatalf("run inspection: %v", err)
	}
	if result.Run.DeleteCount != 1 {
		t.Fatalf("delete count = %d, want 1", result.Run.DeleteCount)
	}
	if result.Run.Error != "" {
		t.Fatalf("run error = %q", result.Run.Error)
	}
	if legacyDeleteCalls != 1 || managementDeleteCalls != 1 {
		t.Fatalf("delete counts legacy=%d management=%d, want 1/1", legacyDeleteCalls, managementDeleteCalls)
	}
}

func TestRunFallsBackToManagementAuthFileStatusActionPath(t *testing.T) {
	var legacyPatchCalls int
	var managementPatchCalls int
	var patchedDisabled bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/auth-files" && r.Method == http.MethodGet:
			http.NotFound(w, r)
		case r.URL.Path == "/v0/management/auth-files" && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"files":[{"name":"auth-a.json","auth_index":"auth-1","provider":"codex","account":"alice@example.com","status":"ok","state":"ready"}]}`))
		case r.URL.Path == "/api-call" && r.Method == http.MethodPost:
			http.NotFound(w, r)
		case r.URL.Path == "/v0/management/api-call" && r.Method == http.MethodPost:
			_, _ = w.Write([]byte(`{"status_code":402,"body":{"message":"limit reached"}}`))
		case strings.HasPrefix(r.URL.Path, "/auth-files") && r.Method == http.MethodPatch:
			legacyPatchCalls++
			http.NotFound(w, r)
		case r.URL.Path == "/v0/management/auth-files" && r.Method == http.MethodPatch:
			managementPatchCalls++
			var payload struct {
				Name     string `json:"name"`
				Disabled bool   `json:"disabled"`
			}
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatalf("decode patch payload: %v", err)
			}
			if payload.Name != "auth-a.json" {
				t.Fatalf("patch name = %q, want auth-a.json", payload.Name)
			}
			patchedDisabled = payload.Disabled
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(upstream.Close)

	db := newCodexInspectionTestStore(t)
	if err := db.SaveManagerConfig(context.Background(), newCodexInspectionManagerConfig(upstream.URL)); err != nil {
		t.Fatalf("save manager config: %v", err)
	}
	svc := newCodexInspectionTestService(t, db)

	result, err := svc.Run(context.Background(), RunRequest{
		TriggerType: "manual",
		TriggerKey:  "manual",
	})
	if err != nil {
		t.Fatalf("run inspection: %v", err)
	}
	if result.Run.DisableCount != 1 {
		t.Fatalf("disable count = %d, want 1", result.Run.DisableCount)
	}
	if result.Run.Error != "" {
		t.Fatalf("run error = %q", result.Run.Error)
	}
	if legacyPatchCalls != 2 || managementPatchCalls != 1 {
		t.Fatalf("patch counts legacy=%d management=%d, want 2/1", legacyPatchCalls, managementPatchCalls)
	}
	if !patchedDisabled {
		t.Fatal("management patch did not disable the auth file")
	}
}

func TestRunFinalizesAfterContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/auth-files" && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"files":[{"name":"auth-a.json","auth_index":"auth-1","provider":"codex","account":"alice@example.com","status":"ok","state":"ready"}]}`))
		case r.URL.Path == "/api-call" && r.Method == http.MethodPost:
			cancel()
			time.Sleep(20 * time.Millisecond)
			_, _ = w.Write([]byte(`{"status_code":200,"body":{"ok":true}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(upstream.Close)

	db := newCodexInspectionTestStore(t)
	if err := db.SaveManagerConfig(context.Background(), newCodexInspectionManagerConfig(upstream.URL)); err != nil {
		t.Fatalf("save manager config: %v", err)
	}
	svc := newCodexInspectionTestService(t, db)

	result, err := svc.Run(ctx, RunRequest{
		TriggerType: "manual",
		TriggerKey:  "manual",
	})
	if err != nil {
		t.Fatalf("run inspection after cancellation: %v", err)
	}
	if result.Run.Status == model.CodexInspectionStatusRunning {
		t.Fatalf("run stayed running: %#v", result.Run)
	}

	runs, err := db.ListCodexInspectionRuns(context.Background(), 1)
	if err != nil {
		t.Fatalf("list runs: %v", err)
	}
	if len(runs) != 1 {
		t.Fatalf("runs = %#v", runs)
	}
	if runs[0].Status == model.CodexInspectionStatusRunning || runs[0].FinishedAtMS == 0 {
		t.Fatalf("persisted run was not finalized: %#v", runs[0])
	}
}

func TestCodexInspectionScheduleDue(t *testing.T) {
	enabled := true
	now := mustParseTime(t, "2026-05-22T10:30:00+08:00")

	intervalCfg := model.DefaultCodexInspectionConfig()
	intervalCfg.Enabled = &enabled
	intervalCfg.Schedule.Mode = model.CodexInspectionScheduleModeInterval
	intervalCfg.Schedule.IntervalMinutes = 30
	if !model.CodexInspectionScheduleDue(now, mustParseTime(t, "2026-05-22T09:59:00+08:00"), intervalCfg) {
		t.Fatal("expected interval schedule to be due")
	}

	timePointCfg := model.DefaultCodexInspectionConfig()
	timePointCfg.Enabled = &enabled
	timePointCfg.Schedule.Mode = model.CodexInspectionScheduleModeTimePoints
	timePointCfg.Schedule.TimePoints = []string{"10:30", "18:00"}
	timePointCfg.Schedule.TimeZone = "Asia/Shanghai"
	if !model.CodexInspectionScheduleDue(now, time.Time{}, timePointCfg) {
		t.Fatal("expected time_points schedule to be due")
	}
}

func mustParseTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatalf("parse time: %v", err)
	}
	return parsed
}

func newCodexInspectionManagerConfig(upstreamURL string) store.ManagerConfig {
	enabled := true
	cfg := store.ManagerConfig{
		CPAConnection: store.ManagerCPAConnectionConfig{
			CPABaseURL:    upstreamURL,
			ManagementKey: "management-key",
		},
		Collector: store.ManagerCollectorConfig{
			CollectorMode:  "auto",
			Queue:          "usage",
			PopSide:        "right",
			BatchSize:      100,
			PollIntervalMS: 500,
			QueryLimit:     50000,
		},
		CodexInspection: store.DefaultCodexInspectionConfig(),
	}
	cfg.CodexInspection.Enabled = &enabled
	cfg.CodexInspection.AutoActionMode = model.CodexInspectionAutoActionDelete
	cfg.CodexInspection.Workers = 1
	cfg.CodexInspection.DeleteWorkers = 1
	return cfg
}

func newCodexInspectionTestStore(t *testing.T) *store.Store {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	testutil.EnsureAdminCredential(t, db)
	t.Cleanup(func() {
		_ = db.Close()
	})
	return db
}

func newCodexInspectionTestService(t *testing.T, db *store.Store) *Service {
	t.Helper()
	cfg := config.Config{
		DBPath:        filepath.Join(t.TempDir(), "usage.sqlite"),
		Queue:         "usage",
		PopSide:       "right",
		BatchSize:     100,
		QueryLimit:    50000,
		CORSOrigins:   []string{"*"},
		CollectorMode: "auto",
	}
	manager := collectorpkg.NewManager(cfg, db)
	collectorService := collector.New(manager)
	managerCfg := managerconfigsvc.New(cfg, db, collectorService)
	return New(db, managerCfg, &http.Client{})
}
