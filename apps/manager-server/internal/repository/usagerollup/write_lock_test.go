package usagerollup

import (
	"context"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/repository/usageevent"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

func TestBeginRollupWriteTxAcquiresWriterBeforeSnapshot(t *testing.T) {
	db := newRollupTestDB(t)
	ctx := context.Background()

	tx, err := beginRollupWriteTx(ctx, db, AccountHistoryCheckpointName, time.Now().UnixMilli())
	if err != nil {
		t.Fatalf("begin rollup write transaction: %v", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := checkpointInTx(ctx, tx, AccountHistoryCheckpointName); err != nil {
		t.Fatalf("read checkpoint in write transaction: %v", err)
	}

	writerCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	writerDone := make(chan error, 1)
	go func() {
		_, err := usageevent.New(db).InsertBatch(writerCtx, []usage.Event{
			rollupTestEvent("rollup-write-lock-probe", 1_700_000_001_000, "gpt-a", "", "probe@example.com", "", "auth-probe", false, 1, 1, 0, 0, 0, 0, 2),
		})
		writerDone <- err
	}()

	select {
	case err := <-writerDone:
		t.Fatalf("concurrent usage writer completed while rollup write lock was held: %v", err)
	case <-time.After(200 * time.Millisecond):
	}

	if err := tx.Rollback(); err != nil {
		t.Fatalf("rollback rollup write transaction: %v", err)
	}

	select {
	case err := <-writerDone:
		if err != nil {
			t.Fatalf("usage writer did not recover after rollup rollback: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("usage writer did not complete after rollup write lock was released")
	}

	if _, err := usageevent.New(db).InsertBatch(ctx, []usage.Event{
		rollupTestEvent("rollup-write-lock-after", 1_700_000_002_000, "gpt-a", "", "probe@example.com", "", "auth-probe", false, 1, 1, 0, 0, 0, 0, 2),
	}); err != nil {
		t.Fatalf("usage writer did not recover after rollup rollback: %v", err)
	}
}
