package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"image"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/egoist/mygo"
	"github.com/he-music/HE-Music/desktop/metadata"
)

func scanTestGrant(t *testing.T) (*fileTestActor, context.Context, uint64, string, string) {
	t.Helper()
	actor, ctx, epoch := newFileTestActor(t)
	path := t.TempDir()
	handle, err := openDirectoryHandle(path)
	if err != nil {
		t.Fatal(err)
	}
	token, err := newDirectoryToken()
	if err != nil {
		t.Fatal(err)
	}
	if err := actor.state.main(ctx, func(*mygo.Window) error {
		actor.state.grants = map[string]ownedDirectory{token: {grant: DirectoryGrant{Token: token, Epoch: epoch}, handle: handle}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return actor, ctx, epoch, token, path
}
func scanTestAwaitRemoved(t *testing.T, job *fileScan) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for {
		fileScans.Lock()
		removed := fileScans.jobs[job.id] != job
		fileScans.Unlock()
		if removed {
			return
		}
		select {
		case <-deadline:
			t.Fatal("scan job was not removed")
		case <-tick.C:
		}
	}
}

func scanTestJob(t *testing.T, s *nativeFilesState, ctx context.Context, epoch uint64, token string) *fileScan {
	t.Helper()
	op, err := s.startScan(ctx, epoch, token)
	if err != nil {
		t.Fatal(err)
	}
	job, err := s.scanJob(ctx, epoch, op.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		job.cancel()
		select {
		case <-job.finished:
		case <-time.After(5 * time.Second):
			t.Error("scan worker did not exit")
		}
	})
	return job
}
func scanTestDrain(t *testing.T, job *fileScan) ([]ScanEntry, []ScanIssue) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	cursor := ""
	var entries []ScanEntry
	var issues []ScanIssue
	for {
		page, err := job.state.readScanPage(job.lease.owner, job.lease.epoch, job.id, cursor)
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Entries)+len(page.Issues) > scanPageSize {
			t.Fatal("unbounded page")
		}
		entries = append(entries, page.Entries...)
		issues = append(issues, page.Issues...)
		if page.Done {
			return entries, issues
		}
		cursor = page.NextCursor
		select {
		case <-deadline:
			t.Fatal("scan pages did not finish")
		case <-tick.C:
		}
	}
}
func scanTestWrite(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestScanPagesIssuesAndCursor(t *testing.T) {
	actor, ctx, epoch, token, path := scanTestGrant(t)
	for n := 0; n < scanQueueSize+10; n++ {
		scanTestWrite(t, filepath.Join(path, fmt.Sprintf("%03d.mp3", n)), []byte("plain text, not audio"))
	}
	job := scanTestJob(t, actor.state, ctx, epoch, token)
	if _, err := actor.state.readScanPage(ctx, epoch, job.id, "999"); !errors.Is(err, errFilesScanCursor) {
		t.Fatalf("bad cursor: %v", err)
	}
	first, err := actor.state.readScanPage(ctx, epoch, job.id, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := actor.state.readScanPage(ctx, epoch, job.id, ""); !errors.Is(err, errFilesScanCursor) {
		t.Fatalf("replayed cursor: %v", err)
	}
	count := len(first.Issues)
	cursor := first.NextCursor
	deadline := time.After(5 * time.Second)
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for !first.Done {
		select {
		case <-deadline:
			t.Fatal("stalled")
		case <-tick.C:
		}
		first, err = actor.state.readScanPage(ctx, epoch, job.id, cursor)
		if err != nil {
			t.Fatal(err)
		}
		if len(first.Entries) != 0 || len(first.Issues) > scanPageSize {
			t.Fatal("suffix accepted or unbounded")
		}
		count += len(first.Issues)
		cursor = first.NextCursor
	}
	if count != scanQueueSize+10 {
		t.Fatalf("issues=%d", count)
	}
}

func TestScanReadOnlyEmbeddedTagsWithoutSuffix(t *testing.T) {
	for _, format := range []string{"mp3", "flac"} {
		t.Run(format, func(t *testing.T) {
			actor, ctx, epoch, token, path := scanTestGrant(t)
			ffmpeg, err := exec.LookPath("ffmpeg")
			if err != nil {
				t.Skip("ffmpeg required to generate short MP3/FLAC fixtures")
			}
			target := filepath.Join(path, "music.data")
			codec := "libmp3lame"
			if format == "flac" {
				codec = "flac"
			}
			cmd := exec.Command(ffmpeg, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=0.05", "-metadata", "title=临时扫描标题", "-metadata", "artist=临时艺术家", "-c:a", codec, "-f", format, target)
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("generate audio fixture: %v: %s", err, out)
			}
			// Add a generated embedded image to this private fixture before scanning.
			var picture bytes.Buffer
			if err := png.Encode(&picture, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
				t.Fatal(err)
			}
			fixture, err := os.OpenFile(target, os.O_RDWR, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer fixture.Close()
			stat, err := fixture.Stat()
			if err != nil {
				t.Fatal(err)
			}
			pictures := []metadata.Picture{{MIME: "image/png", Type: 3, Data: picture.Bytes()}}
			if err := metadata.EditWorkingCopy(ctx, fixture, stat.Size(), metadata.Patch{Pictures: &pictures}); err != nil {
				t.Fatal(err)
			}
			fixture.Close()
			before, err := os.ReadFile(target)
			if err != nil {
				t.Fatal(err)
			}
			job := scanTestJob(t, actor.state, ctx, epoch, token)
			entries, issues := scanTestDrain(t, job)
			if len(entries) != 1 || len(issues) != 0 {
				t.Fatalf("entries=%d issues=%v", len(entries), issues)
			}
			entry := entries[0]
			if entry.Metadata.Title != "临时扫描标题" || len(entry.Metadata.Artists) != 1 || entry.Metadata.Artists[0] != "临时艺术家" {
				t.Fatalf("tags: %+v", entry.Metadata)
			}
			if entry.Metadata.PicturesLoaded || len(entry.Metadata.Pictures) != 0 {
				t.Fatal("scan loaded pictures")
			}
			if entry.Ref.RelativePath != "music.data" || entry.Ref.GrantToken != token || entry.Size != int64(len(before)) {
				t.Fatalf("bad ref: %+v", entry)
			}
			lease, err := actor.state.acquireDirectory(ctx, epoch, token)
			if err != nil {
				t.Fatal(err)
			}
			defer lease.Release()
			file, err := actor.state.resolveLocalFile(lease, entry.Ref)
			if err != nil {
				t.Fatal(err)
			}
			file.Close()
			// A cancelled rescan must not delete a stable reference already shown
			// by the first scan when the registry deduplicates the same file.
			rescan := scanTestJob(t, actor.state, ctx, epoch, token)
			select {
			case <-rescan.finished:
			case <-time.After(5 * time.Second):
				t.Fatal("rescan did not finish")
			}
			rescan.cancel()
			scanTestAwaitRemoved(t, rescan)
			file, err = actor.state.resolveLocalFile(lease, entry.Ref)
			if err != nil {
				t.Fatalf("cancelled rescan invalidated a published reference: %v", err)
			}
			file.Close()
			after, err := os.ReadFile(target)
			if err != nil {
				t.Fatal(err)
			}
			if sha256.Sum256(before) != sha256.Sum256(after) {
				t.Fatal("source changed")
			}
			files, err := os.ReadDir(path)
			if err != nil || len(files) != 1 {
				t.Fatalf("sidecar created: %v %v", files, err)
			}
		})
	}
}

func TestScanDepthSymlinksAndFileByteLimit(t *testing.T) {
	actor, ctx, epoch, token, path := scanTestGrant(t)
	deep := path
	for n := 0; n < scanMaxDepth+1; n++ {
		deep = filepath.Join(deep, "d")
		if err := os.Mkdir(deep, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	scanTestWrite(t, filepath.Join(deep, "hidden.mp3"), []byte("text"))
	scanTestWrite(t, filepath.Join(path, "text.mp3"), []byte("text"))
	if err := os.Symlink("text.mp3", filepath.Join(path, "linked.mp3")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("d", filepath.Join(path, "linked-dir")); err != nil {
		t.Fatal(err)
	}
	big, err := os.Create(filepath.Join(path, "large.mp3"))
	if err != nil {
		t.Fatal(err)
	}
	if err := big.Truncate(scanMaxFileBytes + 1); err != nil {
		t.Fatal(err)
	}
	big.Close()
	job := scanTestJob(t, actor.state, ctx, epoch, token)
	entries, issues := scanTestDrain(t, job)
	if len(entries) != 0 {
		t.Fatal("invalid audio accepted")
	}
	counts := map[string]int{}
	for _, issue := range issues {
		counts[issue.Code]++
	}
	if counts["depth-limit"] != 1 || counts["symlink"] != 2 || counts["file-byte-limit"] != 1 || counts["unsupported-or-corrupt"] != 1 {
		t.Fatalf("issues: %v", issues)
	}
}

func TestScanCancelRevokeAndOwnerReplacement(t *testing.T) {
	for _, mode := range []string{"cancel", "revoke", "owner", "parent"} {
		t.Run(mode, func(t *testing.T) {
			actor, ctx, epoch, token, path := scanTestGrant(t)
			for n := 0; n < scanQueueSize+5; n++ {
				scanTestWrite(t, filepath.Join(path, fmt.Sprint(n)), []byte("unsupported"))
			}
			job := scanTestJob(t, actor.state, ctx, epoch, token)
			deadline := time.After(5 * time.Second)
			tick := time.NewTicker(time.Millisecond)
			defer tick.Stop()
			for len(job.queue) < scanQueueSize {
				select {
				case <-deadline:
					t.Fatal("queue did not fill")
				case <-tick.C:
				}
			}
			if err := actor.state.main(ctx, func(*mygo.Window) error {
				if actor.state.busy != nil {
					t.Error("scan occupied picker busy")
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			foreign, cancel := context.WithCancel(context.Background())
			defer cancel()
			if _, err := actor.state.readScanPage(foreign, epoch, job.id, ""); err == nil {
				t.Fatal("foreign page accepted")
			}
			if err := actor.state.cancelScan(foreign, epoch, job.id); err == nil {
				t.Fatal("foreign cancel accepted")
			}
			if _, err := actor.state.readScanPage(ctx, epoch+1, job.id, ""); err == nil {
				t.Fatal("stale epoch accepted")
			}
			switch mode {
			case "cancel":
				if err := actor.state.cancelScan(ctx, epoch, job.id); err != nil {
					t.Fatal(err)
				}
			case "revoke":
				if err := actor.state.revokeDirectory(ctx, epoch, token); err != nil {
					t.Fatal(err)
				}
			case "owner":
				actor.state.dispatch(func() { actor.state.revoke(); actor.owner = foreign })
				if _, err := actor.state.session(foreign); err != nil {
					t.Fatal(err)
				}
			case "parent":
				actor.state.dispatch(func() { actor.parent = &mygo.Window{} })
			}
			if _, err := actor.state.readScanPage(ctx, epoch, job.id, ""); err == nil {
				t.Fatal("late page accepted")
			}
			if mode == "parent" {
				job.cancel()
			}
			select {
			case <-job.finished:
			case <-time.After(5 * time.Second):
				t.Fatal("blocked producer did not cancel")
			}
		})
	}
}

func TestScanLimitsAndBoundedMetadata(t *testing.T) {
	actor, ctx, epoch, token, path := scanTestGrant(t)
	scanTestWrite(t, filepath.Join(path, "file"), []byte("text"))
	// Exercise item/aggregate-byte stopping at the boundary without allocating a
	// huge library. walk consumes the same counters used by the production worker.
	for _, mode := range []string{"items", "bytes"} {
		lease, err := actor.state.acquireDirectory(ctx, epoch, token)
		if err != nil {
			t.Fatal(err)
		}
		job := &fileScan{state: actor.state, lease: lease, ctx: lease.Context(), queue: make(chan scanEvent, 2)}
		items := 0
		var bytes int64
		expected := "item-limit"
		if mode == "items" {
			items = scanMaxItems
		} else {
			bytes = scanMaxBytes
			expected = "byte-limit"
		}
		if job.walk("", 0, &items, &bytes) {
			t.Fatalf("%s limit ignored", mode)
		}
		event := <-job.queue
		if event.issue == nil || event.issue.Code != expected {
			t.Fatalf("%s: %+v", mode, event)
		}
		lease.Release()
	}
	info := boundedScanInfo(metadata.Info{Title: strings.Repeat("歌", 1000), Artists: make([]string, 100), PicturesLoaded: true, Pictures: []metadata.Picture{{Data: []byte("image")}}})
	if len(info.Title) > 1024 || !utf8.ValidString(info.Title) || len(info.Artists) != 8 || info.PicturesLoaded || info.Pictures != nil {
		t.Fatalf("unbounded metadata: %+v", info)
	}
}

func TestScanWorkerReferenceSurvivesOwnerCancellation(t *testing.T) {
	actor, ctx, epoch, token, _ := scanTestGrant(t)
	lease, err := actor.state.acquireDirectory(ctx, epoch, token)
	if err != nil {
		t.Fatal(err)
	}
	// A worker's independent hold survives revocation and explicit lease release
	// until that worker's IO has actually exited.
	if !lease.handle.retainLease() {
		t.Fatal("retain")
	}
	job := &fileScan{state: actor.state, lease: lease}
	actor.state.dispatch(actor.state.revoke)
	lease.Release()
	if lease.handle.closed.Load() {
		t.Fatal("Root closed before worker exit")
	}
	job.releaseWorker()
	actor.state.cleanup.Wait()
	if !lease.handle.closed.Load() {
		t.Fatal("Root not closed after worker exit")
	}
}

func TestScanOperationLimitAndCompletedLeaseRelease(t *testing.T) {
	actor, ctx, epoch, token, _ := scanTestGrant(t)
	jobs := make([]*fileScan, 0, scanMaxOperations)
	for n := 0; n < scanMaxOperations; n++ {
		job := scanTestJob(t, actor.state, ctx, epoch, token)
		select {
		case <-job.finished:
		case <-time.After(5 * time.Second):
			t.Fatal("empty job did not finish")
		}
		if !job.lease.released.Load() || job.lease.handle.leaseCount.Load() != 0 {
			t.Fatal("completed worker retained Root")
		}
		jobs = append(jobs, job)
	}
	if _, err := actor.state.startScan(ctx, epoch, token); !errors.Is(err, errFilesBusy) {
		t.Fatalf("operation cap: %v", err)
	}
	for _, job := range jobs {
		entries, issues := scanTestDrain(t, job)
		if len(entries)+len(issues) != 0 {
			t.Fatal("empty scan had results")
		}
	}
	next := scanTestJob(t, actor.state, ctx, epoch, token)
	scanTestDrain(t, next)
}

func TestScanConcurrentCursorConsumption(t *testing.T) {
	actor, ctx, epoch, token, path := scanTestGrant(t)
	for n := 0; n < scanQueueSize+5; n++ {
		scanTestWrite(t, filepath.Join(path, fmt.Sprint(n)), []byte("unsupported"))
	}
	job := scanTestJob(t, actor.state, ctx, epoch, token)
	start := make(chan struct{})
	results := make(chan error, 2)
	for n := 0; n < 2; n++ {
		go func() { <-start; _, err := actor.state.readScanPage(ctx, epoch, job.id, ""); results <- err }()
	}
	close(start)
	successes, rejected := 0, 0
	for n := 0; n < 2; n++ {
		select {
		case err := <-results:
			if err == nil {
				successes++
			} else if errors.Is(err, errFilesScanCursor) {
				rejected++
			} else {
				t.Fatal(err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("concurrent page blocked")
		}
	}
	if successes != 1 || rejected != 1 {
		t.Fatalf("successes=%d rejected=%d", successes, rejected)
	}
}

func TestScanCompletedUnreadJobIsRemovedOnGrantRevoke(t *testing.T) {
	actor, ctx, epoch, token, _ := scanTestGrant(t)
	job := scanTestJob(t, actor.state, ctx, epoch, token)
	select {
	case <-job.finished:
	case <-time.After(5 * time.Second):
		t.Fatal("empty scan did not finish")
	}
	if err := actor.state.revokeDirectory(ctx, epoch, token); err != nil {
		t.Fatal(err)
	}
	select {
	case <-job.ctx.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("completed scan ignored grant revocation")
	}
	scanTestAwaitRemoved(t, job)
}
