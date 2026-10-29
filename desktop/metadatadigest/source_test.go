package metadatadigest

import (
	"context"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"runtime"
	"testing"
)

func TestSourceFixture(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "fixture")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	data := []byte("HE-Music native metadata match fixture\x00\xff")
	if _, err := file.Write(data); err != nil {
		t.Fatal(err)
	}
	got, err := Source(context.Background(), file)
	sha, match := sha256.Sum256(data), md5.Sum(data)
	if err != nil || got.SHA256 != hex.EncodeToString(sha[:]) || got.MD5 != hex.EncodeToString(match[:]) {
		t.Fatalf("digests=%+v err=%v", got, err)
	}
	if got.MD5 == got.SHA256 {
		t.Fatal("match digest substituted baseline")
	}
}

func TestSourceBoundedMemoryAndCancellation(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "large-fixture")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := file.Truncate(80 << 20); err != nil {
		t.Fatal(err)
	}
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	got, err := Source(context.Background(), file)
	runtime.ReadMemStats(&after)
	if err != nil || len(got.MD5) != 32 || len(got.SHA256) != 64 {
		t.Fatalf("%+v %v", got, err)
	}
	if allocated := after.TotalAlloc - before.TotalAlloc; allocated > 1<<20 {
		t.Fatalf("allocated %d bytes for 80 MiB fixture", allocated)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	got, err = Source(ctx, file)
	if !errors.Is(err, context.Canceled) || got != (Result{}) {
		t.Fatalf("cancel leaked digest: %+v %v", got, err)
	}
	if err := file.Truncate(0); err != nil {
		t.Fatal(err)
	}
	if _, err := Source(context.Background(), file); !errors.Is(err, ErrEmpty) {
		t.Fatal(err)
	}
	file.Close()
	if _, err := Source(context.Background(), file); err == nil {
		t.Fatal("closed source accepted")
	}
}
