//go:build darwin

package main

import (
	"context"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo"
)

func TestMetadataMatchReadDigestAndAuthority(t *testing.T) {
	dir := metadataFixture(t, "flac")
	file := filepath.Join(dir, "song.mp3")
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	f, ctx, epoch, ref := metadataTestService(t, dir)
	result := f.ReadMetadata(ctx, epoch, ref)
	sha, match := sha256.Sum256(data), md5.Sum(data)
	if result.Code != "ok" || result.MD5 != hex.EncodeToString(match[:]) || result.SHA256 != hex.EncodeToString(sha[:]) || result.Ref == nil || *result.Ref != ref || result.Info == nil {
		t.Fatalf("bad native digest result: %+v", result)
	}
	checks := []struct {
		name  string
		ctx   context.Context
		epoch uint64
		ref   LocalFileRef
	}{
		{"foreign owner", context.Background(), epoch, ref},
		{"stale epoch", ctx, epoch + 1, ref},
	}
	forged := ref
	forged.Version = "forged"
	checks = append(checks, struct {
		name  string
		ctx   context.Context
		epoch uint64
		ref   LocalFileRef
	}{"forged version", ctx, epoch, forged})
	forged = ref
	forged.GrantToken = "forged"
	checks = append(checks, struct {
		name  string
		ctx   context.Context
		epoch uint64
		ref   LocalFileRef
	}{"forged grant", ctx, epoch, forged})
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	checks = append(checks, struct {
		name  string
		ctx   context.Context
		epoch uint64
		ref   LocalFileRef
	}{"cancelled context", cancelled, epoch, ref})
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			got := f.ReadMetadata(check.ctx, check.epoch, check.ref)
			if got.Code == "ok" || got.MD5 != "" || got.SHA256 != "" || got.Info != nil {
				t.Fatalf("authority failure leaked metadata: %+v", got)
			}
		})
	}
	replacement := filepath.Join(dir, "replacement")
	if err := os.WriteFile(replacement, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, file); err != nil {
		t.Fatal(err)
	}
	if got := f.ReadMetadata(ctx, epoch, ref); got.Code != "conflict" || got.MD5 != "" {
		t.Fatalf("replacement accepted: %+v", got)
	}
}

func TestMetadataMatchReadRevocationDiscardsPendingDigest(t *testing.T) {
	dir := metadataFixture(t, "mp3")
	f, ctx, epoch, ref := metadataTestService(t, dir)
	originalMain := f.state.main
	paused, resume := make(chan struct{}), make(chan struct{})
	var first sync.Once
	f.state.main = func(caller context.Context, fn func(*mygo.Window) error) error {
		err := originalMain(caller, fn)
		first.Do(func() { close(paused); <-resume })
		return err
	}
	done := make(chan MetadataResult, 1)
	go func() { done <- f.ReadMetadata(ctx, epoch, ref) }()
	select {
	case <-paused:
	case <-time.After(3 * time.Second):
		t.Fatal("read did not acquire lease")
	}
	f.state.dispatch(f.state.revoke)
	close(resume)
	select {
	case got := <-done:
		if got.Code == "ok" || got.MD5 != "" || got.SHA256 != "" || got.Info != nil {
			t.Fatalf("revocation leaked metadata: %+v", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("revocation did not end read")
	}
}
