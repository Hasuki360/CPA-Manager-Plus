package sqlite

import (
	"database/sql"
	"net/url"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

func Open(path string) (*sql.DB, error) {
	return OpenWithOptions(Options{Path: path})
}

func OpenWithOptions(options Options) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(options.Path), 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", dataSourceName(options.Path))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(options.maxOpenConns())
	db.SetMaxIdleConns(options.maxIdleConns())
	db.SetConnMaxIdleTime(options.connMaxIdleTime())
	if err := Migrate(db); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

func dataSourceName(path string) string {
	dsn := &url.URL{
		Scheme: "file",
		Path:   filepath.ToSlash(path),
	}
	query := dsn.Query()
	query.Add("_pragma", "busy_timeout(5000)")
	query.Add("_pragma", "foreign_keys(1)")
	query.Add("_pragma", "synchronous(FULL)")
	dsn.RawQuery = query.Encode()
	return dsn.String()
}
