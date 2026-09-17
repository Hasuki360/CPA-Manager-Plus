package main

import (
	"bytes"
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/buildinfo"
)

func TestWriteVersion(t *testing.T) {
	for _, arg := range []string{"-v", "--version"} {
		t.Run(arg, func(t *testing.T) {
			var stdout bytes.Buffer
			handled, err := writeVersion([]string{arg}, &stdout)
			if err != nil {
				t.Fatalf("writeVersion(%q): %v", arg, err)
			}
			if !handled {
				t.Fatalf("writeVersion(%q) handled = false, want true", arg)
			}
			if got, want := stdout.String(), buildinfo.Version+"\n"; got != want {
				t.Fatalf("writeVersion(%q) output = %q, want %q", arg, got, want)
			}
		})
	}
}

func TestNewPprofServer(t *testing.T) {
	tests := []struct {
		name    string
		addr    string
		wantNil bool
		wantErr bool
	}{
		{name: "disabled", wantNil: true},
		{name: "ipv4 loopback", addr: "127.0.0.1:6060"},
		{name: "ipv6 loopback", addr: "[::1]:6060"},
		{name: "localhost", addr: "localhost:6060"},
		{name: "all interfaces", addr: ":6060", wantErr: true},
		{name: "public address", addr: "0.0.0.0:6060", wantErr: true},
		{name: "invalid", addr: "localhost", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server, err := newPprofServer(tt.addr)
			if (err != nil) != tt.wantErr {
				t.Fatalf("newPprofServer(%q) error = %v", tt.addr, err)
			}
			if tt.wantNil && server != nil {
				t.Fatalf("newPprofServer(%q) = %#v, want nil", tt.addr, server)
			}
			if !tt.wantNil && !tt.wantErr && server == nil {
				t.Fatalf("newPprofServer(%q) = nil", tt.addr)
			}
		})
	}
}


