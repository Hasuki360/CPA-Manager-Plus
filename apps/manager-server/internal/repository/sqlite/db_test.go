package sqlite

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func TestOpenWithOptionsAppliesConnectionDefaults(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "usage ? #.sqlite")
	db, err := OpenWithOptions(Options{Path: dbPath})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})

	connections := make([]*sql.Conn, 0, defaultMaxOpenConns)
	for i := 0; i < defaultMaxOpenConns; i++ {
		conn, err := db.Conn(context.Background())
		if err != nil {
			t.Fatalf("open connection %d: %v", i, err)
		}
		connections = append(connections, conn)
		assertConnectionPragmas(t, conn)
	}

	stats := db.Stats()
	if stats.MaxOpenConnections != defaultMaxOpenConns {
		t.Fatalf("MaxOpenConnections = %d, want %d", stats.MaxOpenConnections, defaultMaxOpenConns)
	}
	if stats.OpenConnections != defaultMaxOpenConns || stats.InUse != defaultMaxOpenConns {
		t.Fatalf("open/in-use connections = %d/%d, want %d/%d", stats.OpenConnections, stats.InUse, defaultMaxOpenConns, defaultMaxOpenConns)
	}

	for i, conn := range connections {
		if err := conn.Close(); err != nil {
			t.Fatalf("close connection %d: %v", i, err)
		}
	}
	stats = db.Stats()
	if stats.Idle != defaultMaxIdleConns {
		t.Fatalf("idle connections = %d, want %d", stats.Idle, defaultMaxIdleConns)
	}
	if stats.MaxIdleClosed != int64(defaultMaxOpenConns-defaultMaxIdleConns) {
		t.Fatalf("MaxIdleClosed = %d, want %d", stats.MaxIdleClosed, defaultMaxOpenConns-defaultMaxIdleConns)
	}
}

func assertConnectionPragmas(t *testing.T, conn *sql.Conn) {
	t.Helper()
	for _, test := range []struct {
		name  string
		query string
		want  int
	}{
		{name: "busy timeout", query: "pragma busy_timeout", want: 5000},
		{name: "foreign keys", query: "pragma foreign_keys", want: 1},
		{name: "synchronous", query: "pragma synchronous", want: 2},
	} {
		var got int
		if err := conn.QueryRowContext(context.Background(), test.query).Scan(&got); err != nil {
			t.Fatalf("query %s: %v", test.name, err)
		}
		if got != test.want {
			t.Fatalf("%s = %d, want %d", test.name, got, test.want)
		}
	}
}
