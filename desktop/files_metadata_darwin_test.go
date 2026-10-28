//go:build darwin

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/he-music/HE-Music/desktop/metadata"
	"github.com/tommyo123/mtag"
	"github.com/tommyo123/mtag/id3v2"
)

func metadataFixture(t *testing.T, format string) string {
	t.Helper()
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg fixture generator unavailable")
	}
	dir := t.TempDir()
	if base := os.Getenv("METADATA_FIXTURE_DIR"); base != "" {
		var err error
		dir, err = os.MkdirTemp(base, "native-metadata-")
		if err != nil {
			t.Fatal(err)
		}
	}
	name := filepath.Join(dir, "song.mp3") // Content, never extension, selects format.
	args := []string{"-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=0.25", "-map_metadata", "-1"}
	if format == "mp3" {
		args = append(args, "-c:a", "libmp3lame", "-b:a", "128k", "-id3v2_version", "3", "-f", "mp3")
	} else {
		args = append(args, "-c:a", "flac", "-f", "flac")
	}
	args = append(args, name)
	if out, err := exec.Command("ffmpeg", args...).CombinedOutput(); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	// An unknown vendor tag/frame must survive the production working-copy save.
	tag, err := mtag.Open(name)
	if err != nil {
		t.Fatal(err)
	}
	if format == "mp3" {
		tag.ID3v2().Set(&id3v2.RawFrame{FrameID: "XABC", Data: []byte("opaque-vendor-data")})
	} else {
		tag.SetCustomValues("VENDOR_TEST", "opaque-vendor-data")
	}
	if err = tag.Save(); err != nil {
		t.Fatal(err)
	}
	tag.Close()
	if out, err := exec.Command("xattr", "-w", "com.hemusic.fixture", "preserved", name).CombinedOutput(); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if out, err := exec.Command("chmod", "+a", "everyone allow read,readattr,readextattr,readsecurity", name).CombinedOutput(); err != nil {
		t.Fatalf("ACL fixture %v: %s", err, out)
	}
	t.Logf("generated fixture %s (%s)", name, format)
	return dir
}
func metadataPackets(t *testing.T, name string) []byte {
	t.Helper()
	out, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "a:0", "-show_packets", "-show_entries", "packet=data_hash", "-show_data_hash", "sha256", "-of", "json", name).Output()
	if err != nil {
		t.Fatal(err)
	}
	var data struct {
		Packets []struct {
			Hash string `json:"data_hash"`
		} `json:"packets"`
	}
	if err = json.Unmarshal(out, &data); err != nil || len(data.Packets) == 0 {
		t.Fatalf("packets: %v %s", err, out)
	}
	for _, p := range data.Packets {
		if !strings.HasPrefix(p.Hash, "SHA256:") {
			t.Fatal("missing packet hash")
		}
	}
	return out
}
func TestMetadataRealOriginalSaveAndDedup(t *testing.T) {
	for _, format := range []string{"mp3", "flac"} {
		t.Run(format, func(t *testing.T) {
			dir := metadataFixture(t, format)
			name := filepath.Join(dir, "song.mp3")
			before := metadataPackets(t, name)
			beforeACL := metadataACL(t, name)
			original, _ := os.Stat(name)
			f, ctx, epoch, ref := metadataTestService(t, dir)
			read := f.ReadMetadata(ctx, epoch, ref)
			if read.Code != "ok" {
				t.Fatalf("read %+v", read)
			}
			title := "原件写回测试"
			artists := []string{"艺人甲", "艺人乙"}
			req := MetadataSaveRequest{OperationID: metadataTestNonce(t), Ref: ref, SHA256: read.SHA256, Patch: metadata.Patch{Title: &title, Artists: &artists}}
			result := f.SaveMetadata(ctx, epoch, req)
			if result.Code != "ok" || !result.Committed || result.Ref == nil || *result.Ref == ref {
				t.Fatalf("save %+v", result)
			}
			after, _ := os.Stat(name)
			if metadataACL(t, name) != beforeACL {
				t.Fatal("ACL changed")
			}
			if os.SameFile(original, after) {
				t.Fatal("original inode was not replaced")
			}
			if got := metadataPackets(t, name); !bytes.Equal(got, before) {
				t.Fatal("independent ffprobe packet hashes changed")
			}
			out, err := exec.Command("xattr", "-p", "com.hemusic.fixture", name).Output()
			if err != nil || strings.TrimSpace(string(out)) != "preserved" {
				t.Fatalf("xattr %q %v", out, err)
			}
			tag, err := mtag.Open(name)
			if err != nil {
				t.Fatal(err)
			}
			if format == "mp3" {
				frames := tag.ID3v2().FindAll("XABC")
				if len(frames) != 1 || !bytes.Equal(frames[0].(*id3v2.RawFrame).Data, []byte("opaque-vendor-data")) {
					t.Fatal("unknown frame lost")
				}
			} else if strings.Join(tag.CustomValues("VENDOR_TEST"), "") != "opaque-vendor-data" {
				t.Fatal("unknown comment lost")
			}
			tag.Close()
			reread := f.ReadMetadata(ctx, epoch, *result.Ref)
			if reread.Code != "ok" || reread.Info.Title != title {
				t.Fatalf("reread %+v", reread)
			}
			if old := f.ReadMetadata(ctx, epoch, ref); old.Code != "conflict" {
				t.Fatalf("old ref %+v", old)
			}
			repeat := f.SaveMetadata(ctx, epoch, req)
			if repeat.Code != "ok" || repeat.Ref == nil || *repeat.Ref != *result.Ref {
				t.Fatalf("dedup %+v", repeat)
			}
			final, _ := os.Stat(name)
			if !os.SameFile(after, final) {
				t.Fatal("dedup wrote twice")
			}
			emptyTitle := ""
			emptyArtists := []string{}
			emptyPictures := []metadata.Picture{}
			clear := f.SaveMetadata(ctx, epoch, MetadataSaveRequest{OperationID: metadataTestNonce(t), Ref: *result.Ref, SHA256: result.SHA256, Patch: metadata.Patch{Title: &emptyTitle, Artists: &emptyArtists, Pictures: &emptyPictures}})
			if clear.Code != "ok" || clear.Info.Title != "" || len(clear.Info.Artists) != 0 || len(clear.Info.Pictures) != 0 {
				t.Fatalf("clear %+v", clear)
			}
			entries, _ := os.ReadDir(dir)
			if len(entries) != 1 {
				t.Fatalf("temporary files remain: %v", entries)
			}
		})
	}
}
func TestMetadataDrainCancelRevokeAndExternalConflict(t *testing.T) {
	for _, mode := range []string{"cancel", "revoke", "external", "server"} {
		t.Run(mode, func(t *testing.T) {
			dir := metadataFixture(t, "mp3")
			name := filepath.Join(dir, "song.mp3")
			before, _ := os.ReadFile(name)
			f, ctx, epoch, ref := metadataTestService(t, dir)
			read := f.ReadMetadata(ctx, epoch, ref)
			if read.Code != "ok" {
				t.Fatal(read)
			}
			id := metadataTestNonce(t)
			title := "should not save"
			oldHook := metadataAudioDrain
			t.Cleanup(func() { metadataAudioDrain = oldHook })
			released := false
			metadataAudioDrain = func(op context.Context, service *NativeFiles, info os.FileInfo) (func(), error) {
				if f.state.busy != nil {
					t.Fatal("metadata occupied picker busy")
				}
				switch mode {
				case "cancel":
					if result := service.CancelMetadata(ctx, epoch, id); result.Code != "ok" {
						t.Fatal(result)
					}
					<-op.Done()
					return nil, op.Err()
				case "revoke":
					if err := service.RevokeDirectory(ctx, epoch, ref.GrantToken); err != nil {
						t.Fatal(err)
					}
					<-op.Done()
					return nil, op.Err()
				case "external":
					// Modify bytes without changing size/mtime. Full SHA256 must detect this.
					file, err := os.OpenFile(name, os.O_RDWR, 0)
					if err != nil {
						t.Fatal(err)
					}
					one := []byte{before[len(before)-1] ^ 1}
					if _, err = file.WriteAt(one, int64(len(before)-1)); err != nil {
						t.Fatal(err)
					}
					file.Close()
					os.Chtimes(name, info.ModTime(), info.ModTime())
				}
				return func() { released = true }, nil
			}
			if mode == "server" {
				metadataAudioDrain = nil
				audioServerFor(&f.state)
				t.Cleanup(func() { f.shutdownLocalAudio() })
			}
			result := f.SaveMetadata(ctx, epoch, MetadataSaveRequest{OperationID: id, Ref: ref, SHA256: read.SHA256, Patch: metadata.Patch{Title: &title}})
			want := map[string]string{"cancel": "cancelled", "revoke": "revoked", "external": "conflict", "server": "readers_unavailable"}[mode]
			if result.Code != want || result.Committed {
				t.Fatalf("want %s got %+v", want, result)
			}
			if mode == "external" && !released {
				t.Fatal("drain gate leaked")
			}
			after, _ := os.ReadFile(name)
			if mode != "external" && !bytes.Equal(before, after) {
				t.Fatal("failed save changed original")
			}
			entries, _ := os.ReadDir(dir)
			if len(entries) != 1 {
				t.Fatalf("temporary files remain: %v", entries)
			}
		})
	}
}
func TestMetadataLockWaitCancelReleasesLease(t *testing.T) {
	dir := metadataFixture(t, "mp3")
	f, ctx, epoch, ref := metadataTestService(t, dir)
	read := f.ReadMetadata(ctx, epoch, ref)
	info, _ := os.Stat(filepath.Join(dir, "song.mp3"))
	c := metadataCoordinatorFor(&f.state)
	unlock, err := c.lock(context.Background(), info)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	id := metadataTestNonce(t)
	done := make(chan MetadataResult, 1)
	go func() {
		done <- f.SaveMetadata(ctx, epoch, MetadataSaveRequest{OperationID: id, Ref: ref, SHA256: read.SHA256})
	}()
	deadline := time.Now().Add(time.Second)
	for {
		c.mu.Lock()
		job := c.jobs[id]
		c.mu.Unlock()
		if job != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("job not registered")
		}
		time.Sleep(time.Millisecond)
	}
	if result := f.CancelMetadata(ctx, epoch, id); result.Code != "ok" {
		t.Fatal(result)
	}
	select {
	case result := <-done:
		if result.Code != "cancelled" {
			t.Fatal(result)
		}
	case <-time.After(time.Second):
		t.Fatal("lock wait did not cancel")
	}
	f.state.main(ctx, func(_ *mygo.Window) error {
		if f.state.busy != nil {
			t.Fatal("picker busy")
		}
		return nil
	})
}

func metadataACL(t *testing.T, name string) string {
	t.Helper()
	out, err := exec.Command("ls", "-le", name).Output()
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(string(out), "\n")
	return strings.Join(lines[1:], "\n")
}
func TestMetadataRenameFailureRetainsRecoveryBackup(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("permissions require unprivileged fixture process")
	}
	dir := metadataFixture(t, "mp3")
	name := filepath.Join(dir, "song.mp3")
	before, _ := os.ReadFile(name)
	f, ctx, epoch, ref := metadataTestService(t, dir)
	read := f.ReadMetadata(ctx, epoch, ref)
	hook := metadataAudioDrain
	t.Cleanup(func() { metadataAudioDrain = hook; os.Chmod(dir, 0700) })
	metadataAudioDrain = func(context.Context, *NativeFiles, os.FileInfo) (func(), error) {
		if err := os.Chmod(dir, 0500); err != nil {
			t.Fatal(err)
		}
		return func() { os.Chmod(dir, 0700) }, nil
	}
	title := "replacement denied"
	result := f.SaveMetadata(ctx, epoch, MetadataSaveRequest{OperationID: metadataTestNonce(t), Ref: ref, SHA256: read.SHA256, Patch: metadata.Patch{Title: &title}})
	if result.Code != "replace_failed" || result.Committed || result.RecoveryName == "" || filepath.IsAbs(result.RecoveryName) {
		t.Fatalf("%+v", result)
	}
	after, _ := os.ReadFile(name)
	backup, err := os.ReadFile(filepath.Join(dir, result.RecoveryName))
	if err != nil || !bytes.Equal(after, before) || !bytes.Equal(backup, before) {
		t.Fatalf("original/recovery mismatch %v", err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 3 || len(result.ResidualNames) != 1 || !strings.HasPrefix(filepath.Base(result.ResidualNames[0]), metadataPrivatePrefix+"work-") {
		t.Fatalf("unexpected artifacts %v result %+v", entries, result)
	}
}

func TestMetadataRejectsFileFlags(t *testing.T) {
	dir := metadataFixture(t, "mp3")
	name := filepath.Join(dir, "song.mp3")
	if out, err := exec.Command("chflags", "nodump", name).CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	t.Cleanup(func() { exec.Command("chflags", "0", name).Run() })
	f, ctx, epoch, ref := metadataTestService(t, dir)
	read := f.ReadMetadata(ctx, epoch, ref)
	if read.Code != "ok" {
		t.Fatal(read)
	}
	result := f.SaveMetadata(ctx, epoch, MetadataSaveRequest{OperationID: metadataTestNonce(t), Ref: ref, SHA256: read.SHA256})
	if result.Code != "attributes_unsupported" || result.Committed {
		t.Fatalf("%+v", result)
	}
}
