package automation

import (
	"context"
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/config"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
)

func TestCharityUpdateReturnsLastKnownSyncState(t *testing.T) {
	st, err := store.Open(t.TempDir() + "/usage.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()
	if _, err := st.SaveCharityModelMonitorState(ctx, store.CharityModelMonitorState{
		LastCheck: "2026-09-08T00:00:00Z", LastCodexCLIVersion: "0.153.4",
	}); err != nil {
		t.Fatal(err)
	}
	status, err := New(config.Config{}, st).Update(ctx, UpdateRequest{CharityModelMonitorEnabled: boolPtr(true)})
	if err != nil {
		t.Fatal(err)
	}
	if status.CharityModelMonitorState == nil || status.CharityModelMonitorState.LastCodexCLIVersion != "0.153.4" {
		t.Fatalf("saving dropped sync state: %#v", status.CharityModelMonitorState)
	}
}

func TestEmptyCharitySitesSurvivePersistenceAndRuntimeReload(t *testing.T) {
	st, err := store.Open(t.TempDir() + "/usage.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()
	svc := New(config.Config{}, st)
	_, err = svc.Update(ctx, UpdateRequest{
		CharityModelMonitorEnabled: boolPtr(true),
		CharityModelMonitorSites:   []store.CharityModelMonitorSite{},
	})
	if err != nil {
		t.Fatal(err)
	}
	saved, ok, err := st.LoadAutomationSettings(ctx)
	if err != nil || !ok {
		t.Fatalf("load saved settings: ok=%v err=%v", ok, err)
	}
	if saved.CharityModelMonitorSites == nil {
		t.Fatal("explicit empty site list was lost during JSON persistence")
	}
	reloaded := New(config.Config{}, st).RuntimeSettings(ctx)
	if len(reloaded.CharityModelMonitorSites) != 0 {
		t.Fatalf("empty targets restored defaults: %#v", reloaded.CharityModelMonitorSites)
	}
	if !reloaded.CharityModelMonitorEnabled {
		t.Fatal("clearing targets must not silently change the enable switch")
	}
}
