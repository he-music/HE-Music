package main

import (
	"bytes"
	"errors"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func nativeTestRequest(t *testing.T, c *downloadCoordinator, token string) DownloadRequest {
	data := downloadMP3()
	c.client.Transport = downloadRoundTripper(func(*http.Request) (*http.Response, error) { return downloadResponse(data, int64(len(data))), nil })
	r := downloadReq(t, token, "song.mp3")
	r.Options = &DownloadOptions{RelativeDirectory: "Artist/Album", SaveSidecars: true, WriteLyrics: true, Metadata: &DownloadMetadata{Lyrics: "text"}}
	return r
}

func TestNativeOwnedTransferFailures(t *testing.T) {
	for _, kind := range []string{"source", "sidecar", "work"} {
		for _, op := range []string{"write", "copy", "sync", "stat", "close", "remove", "lstat"} {
			if op == "copy" && kind != "source" || op == "write" && kind == "work" {
				continue
			}
			t.Run(kind+"/"+op, func(t *testing.T) {
				a, ctx, epoch, c, token, dir := downloadFixture(t)
				req := nativeTestRequest(t, c, token)
				c.io.Before = func(k, o string) error {
					if k == kind && o == op {
						return errors.New("injected")
					}
					return nil
				}
				j := downloadStart(t, a, ctx, epoch, c, req)
				downloadWait(t, j)
				st, err := c.access(a.state, ctx, epoch, req.OperationID, false)
				requireTestNoError(t, err)
				requireTestNotEqual(t, st.Code, "ok")
				requireTestNotEqual(t, st.Code, "durability_uncertain")
				cleanupFault := op == "close" || op == "remove" || op == "lstat"
				if cleanupFault && st.Code != "cleanup_failed" {
					t.Fatalf("cleanup code: %+v", st)
				}
				if st.Committed && st.Ref == nil {
					t.Fatalf("lost committed ref: %+v", st)
				}
				if !st.Committed {
					if _, err := os.Stat(filepath.Join(dir, "Artist/Album/song.mp3")); !os.IsNotExist(err) {
						t.Fatal("published before failure")
					}
				}
				if cleanupFault && op != "close" && st.ResidualName == "" {
					t.Fatal("missing residual")
				}
			})
		}
	}
}

func TestNativePreparationAndCleanupFailure(t *testing.T) {
	for _, kind := range []string{"source", "sidecar"} {
		for _, op := range []string{"write", "sync", "stat"} {
			t.Run(kind+"/"+op, func(t *testing.T) {
				a, ctx, epoch, c, token, _ := downloadFixture(t)
				req := nativeTestRequest(t, c, token)
				c.io.Before = func(k, o string) error {
					if k == kind && (o == op || o == "remove") {
						return errors.New("injected")
					}
					return nil
				}
				j := downloadStart(t, a, ctx, epoch, c, req)
				downloadWait(t, j)
				st, _ := c.access(a.state, ctx, epoch, req.OperationID, false)
				if st.Code != "cleanup_failed" || st.ResidualName == "" || st.Committed {
					t.Fatalf("%+v", st)
				}
			})
		}
	}
}

func TestNativeDirectoryOnlyAndHugeUnusedMetadata(t *testing.T) {
	a, ctx, epoch, c, token, dir := downloadFixture(t)
	req := nativeTestRequest(t, c, token)
	req.Options = &DownloadOptions{RelativeDirectory: "Artist/Album", Metadata: &DownloadMetadata{Lyrics: strings.Repeat("x", downloadOptionLyricsLimit+1), Artists: make([]string, 10000)}}
	j := downloadStart(t, a, ctx, epoch, c, req)
	downloadWait(t, j)
	st, _ := c.access(a.state, ctx, epoch, req.OperationID, false)
	if st.Code != "ok" || st.Ref == nil || st.Ref.RelativePath != "Artist/Album/song.mp3" || j.options != nil {
		t.Fatalf("%+v", st)
	}
	if _, err := os.Stat(filepath.Join(dir, "song.mp3")); !os.IsNotExist(err) {
		t.Fatal("wrong root output")
	}
}

func TestNativeParentReplacementAndSameInodeRoute(t *testing.T) {
	a, ctx, epoch, c, token, dir := downloadFixture(t)
	req := nativeTestRequest(t, c, token)
	c.io.Before = func(k, o string) error {
		if k == "commit" && o == "before_claim" {
			parent := filepath.Join(dir, "Artist/Album")
			entries, err := os.ReadDir(parent)
			if err != nil {
				return err
			}
			if err = os.Rename(parent, parent+"-old"); err != nil {
				return err
			}
			if err = os.Mkdir(parent, 0o700); err != nil {
				return err
			}
			for _, e := range entries {
				if strings.HasPrefix(e.Name(), downloadPrivatePrefix+"work-") {
					return os.Link(filepath.Join(parent+"-old", e.Name()), filepath.Join(parent, "song.mp3"))
				}
			}
		}
		return nil
	}
	j := downloadStart(t, a, ctx, epoch, c, req)
	downloadWait(t, j)
	st, _ := c.access(a.state, ctx, epoch, req.OperationID, false)
	if st.Committed || st.Ref != nil || st.Code != "conflict" {
		t.Fatalf("wrong route accepted: %+v", st)
	}
}

func TestNativeCancelAndRevokeClaimBoundary(t *testing.T) {
	for _, stage := range []string{"before_claim", "after_claim", "after_audio", "after_sidecars"} {
		for _, revoke := range []bool{false, true} {
			t.Run(stage+map[bool]string{true: "/revoke", false: "/cancel"}[revoke], func(t *testing.T) {
				a, ctx, epoch, c, token, _ := downloadFixture(t)
				req := nativeTestRequest(t, c, token)
				c.io.Before = func(k, o string) error {
					if k == "commit" && o == stage {
						if revoke {
							return a.state.revokeDirectory(ctx, epoch, token)
						}
						_, err := c.access(a.state, ctx, epoch, req.OperationID, true)
						return err
					}
					return nil
				}
				j := downloadStart(t, a, ctx, epoch, c, req)
				downloadWait(t, j)
				if revoke {
					if _, err := c.access(a.state, ctx, epoch, req.OperationID, false); err == nil {
						t.Fatal("revoked result exposed")
					}
					return
				}
				st, err := c.access(a.state, ctx, epoch, req.OperationID, false)
				if err != nil {
					t.Fatal(err)
				}
				if st.Ref != nil || !st.Done {
					t.Fatalf("%+v", st)
				}
				if stage != "before_claim" && !st.Committed {
					t.Fatalf("claimed publication lost: %+v", st)
				}
				if stage == "before_claim" && st.Committed {
					t.Fatalf("cancelled preclaim published: %+v", st)
				}
			})
		}
	}
}

func TestNativeChunkedCoverTransfer(t *testing.T) {
	for _, large := range []bool{false, true} {
		t.Run(map[bool]string{false: "small", true: "over_limit"}[large], func(t *testing.T) {
			a, ctx, epoch, c, token, _ := downloadFixture(t)
			req := nativeTestRequest(t, c, token)
			var jpg bytes.Buffer
			if err := jpeg.Encode(&jpg, image.NewRGBA(image.Rect(0, 0, 2, 2)), nil); err != nil {
				t.Fatal(err)
			}
			data := jpg.Bytes()
			if large {
				data = bytes.Repeat([]byte{1}, 16<<20+1)
			}
			req.Options.WriteLyrics = false
			req.Options.WriteCover = true
			req.Options.Metadata.CoverURL = "https://cover.invalid/image"
			c.client.Transport = downloadRoundTripper(func(r *http.Request) (*http.Response, error) {
				if r.URL.Host == "cover.invalid" {
					return &http.Response{StatusCode: 200, ContentLength: -1, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(data))}, nil
				}
				return downloadResponse(downloadMP3(), 834), nil
			})
			j := downloadStart(t, a, ctx, epoch, c, req)
			downloadWait(t, j)
			st, _ := c.access(a.state, ctx, epoch, req.OperationID, false)
			if large {
				if st.Committed || st.Ref != nil {
					t.Fatalf("oversize cover saved: %+v", st)
				}
			} else if !st.Committed || st.Ref == nil || st.Code != "ok" {
				t.Fatalf("small chunked rejected: %+v", st)
			}
		})
	}
}

func TestNativePinnedSourceSurvivesPathReplacement(t *testing.T) {
	a, ctx, epoch, c, token, dir := downloadFixture(t)
	req := nativeTestRequest(t, c, token)
	replacement := ""
	c.io.Before = func(k, o string) error {
		if k == "source" && o == "sync" {
			parent := filepath.Join(dir, "Artist/Album")
			entries, err := os.ReadDir(parent)
			if err != nil {
				return err
			}
			for _, e := range entries {
				if strings.HasPrefix(e.Name(), downloadPrivatePrefix+"source-") {
					replacement = filepath.Join(parent, e.Name())
					if err = os.Rename(replacement, replacement+"-original"); err != nil {
						return err
					}
					return os.WriteFile(replacement, []byte("replacement"), 0o600)
				}
			}
		}
		return nil
	}
	j := downloadStart(t, a, ctx, epoch, c, req)
	downloadWait(t, j)
	st, _ := c.access(a.state, ctx, epoch, req.OperationID, false)
	if !st.Committed || st.Ref == nil || st.Code != "cleanup_failed" || st.ResidualName == "" {
		t.Fatalf("lost pinned baseline/ref: %+v", st)
	}
	if got, err := os.ReadFile(replacement); err != nil || string(got) != "replacement" {
		t.Fatalf("replacement deleted: %q %v", got, err)
	}
}

func TestNativeCleanupRefAndDurabilityTerminals(t *testing.T) {
	a, ctx, epoch, c, token, _ := downloadFixture(t)
	req := nativeTestRequest(t, c, token)
	c.io.DirectoryDurability = func(*os.Root) (bool, error) { return false, nil }
	j := downloadStart(t, a, ctx, epoch, c, req)
	downloadWait(t, j)
	st, _ := c.access(a.state, ctx, epoch, req.OperationID, false)
	if st.Code != "durability_uncertain" || !st.Committed || st.Ref == nil {
		t.Fatalf("%+v", st)
	}
}

func TestNativeSecondSidecarPublishFailureKeepsAudio(t *testing.T) {
	a, ctx, epoch, c, token, dir := downloadFixture(t)
	req := nativeTestRequest(t, c, token)
	var jpg bytes.Buffer
	if err := jpeg.Encode(&jpg, image.NewRGBA(image.Rect(0, 0, 2, 2)), nil); err != nil {
		t.Fatal(err)
	}
	req.Options.WriteCover = true
	req.Options.Metadata.CoverURL = "https://cover.invalid/image"
	c.client.Transport = downloadRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "cover.invalid" {
			return &http.Response{StatusCode: 200, ContentLength: -1, Header: http.Header{"Content-Type": []string{"image/jpeg"}}, Body: io.NopCloser(bytes.NewReader(jpg.Bytes()))}, nil
		}
		return downloadResponse(downloadMP3(), 834), nil
	})
	count := 0
	c.io.Before = func(k, o string) error {
		if k == "sidecar" && o == "publish" {
			count++
			if count == 2 {
				return errors.New("publish failed")
			}
		}
		return nil
	}
	j := downloadStart(t, a, ctx, epoch, c, req)
	downloadWait(t, j)
	st, _ := c.access(a.state, ctx, epoch, req.OperationID, false)
	if st.Code != "partial_committed" || !st.Committed || st.Ref == nil {
		t.Fatalf("%+v", st)
	}
	if _, err := os.Stat(filepath.Join(dir, "Artist/Album/song.lrc")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "Artist/Album/song.jpg")); !os.IsNotExist(err) {
		t.Fatalf("failed sidecar published: %v", err)
	}
}

func TestNativeParentReplacementDuringCoverFetch(t *testing.T) {
	a, ctx, epoch, c, token, dir := downloadFixture(t)
	req := nativeTestRequest(t, c, token)
	var jpg bytes.Buffer
	if err := jpeg.Encode(&jpg, image.NewRGBA(image.Rect(0, 0, 2, 2)), nil); err != nil {
		t.Fatal(err)
	}
	req.Options.WriteCover = true
	req.Options.Metadata.CoverURL = "https://cover.invalid/image"
	changed := false
	c.client.Transport = downloadRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "cover.invalid" {
			return downloadResponse(downloadMP3(), 834), nil
		}
		if !changed {
			changed = true
			parent := filepath.Join(dir, "Artist/Album")
			entries, err := os.ReadDir(parent)
			if err != nil {
				return nil, err
			}
			if err = os.Rename(parent, parent+"-old"); err != nil {
				return nil, err
			}
			if err = os.Mkdir(parent, 0o700); err != nil {
				return nil, err
			}
			for _, e := range entries {
				if strings.HasPrefix(e.Name(), downloadPrivatePrefix+"work-") {
					if err = os.Link(filepath.Join(parent+"-old", e.Name()), filepath.Join(parent, "song.mp3")); err != nil {
						return nil, err
					}
				}
			}
		}
		return &http.Response{StatusCode: 200, ContentLength: -1, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(jpg.Bytes()))}, nil
	})
	j := downloadStart(t, a, ctx, epoch, c, req)
	downloadWait(t, j)
	st, _ := c.access(a.state, ctx, epoch, req.OperationID, false)
	if st.Ref != nil || st.Committed || st.Code != "conflict" {
		t.Fatalf("wrong route ref: %+v", st)
	}
}

func TestNativeOpenTargetClosesPartialAncestors(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "a"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(dir, filepath.Join(dir, "a/b")); err != nil {
		t.Skip(err)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	before, err := os.ReadDir("/dev/fd")
	if err != nil {
		t.Skip("fd inventory unavailable")
	}
	for range 100 {
		if child, _, err := downloadNativeOpenTarget(root, "a/b/song.mp3"); err == nil {
			if child != root {
				_ = child.Close()
			}
			t.Fatal("symlink accepted")
		}
	}
	after, err := os.ReadDir("/dev/fd")
	if err != nil {
		t.Fatal(err)
	}
	if len(after) > len(before)+4 {
		t.Fatalf("root leak: before=%d after=%d", len(before), len(after))
	}
}

func TestNativeDirectorySyncFailureKeepsCommittedRef(t *testing.T) {
	a, ctx, epoch, c, token, _ := downloadFixture(t)
	req := nativeTestRequest(t, c, token)
	c.io.DirectoryDurability = func(*os.Root) (bool, error) { return false, errors.New("sync failed") }
	j := downloadStart(t, a, ctx, epoch, c, req)
	downloadWait(t, j)
	st, _ := c.access(a.state, ctx, epoch, req.OperationID, false)
	if st.Code != "sync_failed" || !st.Committed || st.Ref == nil {
		t.Fatalf("%+v", st)
	}
}

func TestNativeSidecarReplacementIsNeverDeleted(t *testing.T) {
	a, ctx, epoch, c, token, dir := downloadFixture(t)
	req := nativeTestRequest(t, c, token)
	replacement := ""
	c.io.Before = func(k, o string) error {
		if k == "sidecar" && o == "sync" {
			parent := filepath.Join(dir, "Artist/Album")
			entries, err := os.ReadDir(parent)
			if err != nil {
				return err
			}
			for _, e := range entries {
				if strings.HasPrefix(e.Name(), downloadPrivatePrefix+"sidecar-") {
					replacement = filepath.Join(parent, e.Name())
					if err = os.Rename(replacement, replacement+"-original"); err != nil {
						return err
					}
					return os.WriteFile(replacement, []byte("external replacement"), 0o600)
				}
			}
		}
		return nil
	}
	j := downloadStart(t, a, ctx, epoch, c, req)
	downloadWait(t, j)
	st, _ := c.access(a.state, ctx, epoch, req.OperationID, false)
	if st.Code != "cleanup_failed" || !st.Committed || st.Ref == nil || st.ResidualName == "" {
		t.Fatalf("%+v", st)
	}
	if got, err := os.ReadFile(replacement); err != nil || string(got) != "external replacement" {
		t.Fatalf("replacement deleted: %q %v", got, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "Artist/Album/song.lrc")); !os.IsNotExist(err) {
		t.Fatal("unowned sidecar published")
	}
}
