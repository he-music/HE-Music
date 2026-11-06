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
	"syscall"
	"testing"

	"github.com/tommyo123/mtag"

	"github.com/he-music/HE-Music/desktop/metadata"
)

func corruptDownloadWork(dir string, truncate bool) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), downloadPrivatePrefix+"work-") {
			continue
		}
		f, err := os.OpenFile(filepath.Join(dir, entry.Name()), os.O_RDWR, 0)
		if err != nil {
			return err
		}
		defer f.Close()
		if truncate {
			return f.Truncate(4)
		}
		_, err = f.WriteAt([]byte{0xff}, 100)
		return err
	}
	return os.ErrNotExist
}

func TestDownloadOptionalMetadataFailureRestoresAudio(t *testing.T) {
	for _, keep := range []bool{false, true} {
		for _, corrupt := range []bool{false, true} {
			t.Run(map[bool]string{false: "strict", true: "keep"}[keep]+map[bool]string{false: "/writer_failure", true: "/audio_changed"}[corrupt], func(t *testing.T) {
				a, ctx, epoch, c, token, dir := downloadFixture(t)
				data := downloadMP3()
				c.client.Transport = downloadRoundTripper(func(*http.Request) (*http.Response, error) { return downloadResponse(data, int64(len(data))), nil })
				c.io.Before = func(kind, operation string) error {
					if kind != "metadata" || operation != "edit" {
						return nil
					}
					if err := corruptDownloadWork(dir, !corrupt); err != nil {
						return err
					}
					if !corrupt {
						return mtag.ErrContainerWriteUnsupported
					}
					return nil
				}
				req := downloadReq(t, token, "song.mp3")
				req.Options = &DownloadOptions{WriteMetadata: true, KeepAudioOnMetadataFailure: keep, Metadata: &DownloadMetadata{Title: "new title"}}
				j := downloadStart(t, a, ctx, epoch, c, req)
				downloadWait(t, j)
				st, err := c.access(a.state, ctx, epoch, req.OperationID, false)
				if err != nil {
					t.Fatal(err)
				}
				if st.Committed != keep || (st.Ref != nil) != keep || len(st.Issues) != 1 {
					t.Fatalf("unexpected result: %+v", st)
				}
				if keep {
					if st.Code != "ok" {
						t.Fatalf("optional failure rejected: %+v", st)
					}
					after, err := os.ReadFile(filepath.Join(dir, "song.mp3"))
					if err != nil || !bytes.Equal(data, after) {
						t.Fatalf("baseline not restored: %v", err)
					}
				}
				assertDownloadClean(t, dir)
			})
		}
	}
}

func TestDownloadOptionalCoverFailurePreservesTextTags(t *testing.T) {
	for _, kind := range []string{"http", "invalid_image", "missing"} {
		for _, keep := range []bool{false, true} {
			t.Run(kind+map[bool]string{false: "/strict", true: "/keep"}[keep], func(t *testing.T) {
				a, ctx, epoch, c, token, dir := downloadFixture(t)
				c.client.Transport = downloadRoundTripper(func(r *http.Request) (*http.Response, error) {
					if r.URL.Host == "cover.invalid" {
						status := http.StatusOK
						if kind == "http" {
							status = http.StatusNotFound
						}
						return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("not an image")), ContentLength: -1}, nil
					}
					data := downloadMP3()
					return downloadResponse(data, int64(len(data))), nil
				})
				coverURL := "https://cover.invalid/private?token=SECRET"
				if kind == "missing" {
					coverURL = ""
				}
				req := downloadReq(t, token, "song.mp3")
				req.Options = &DownloadOptions{WriteMetadata: true, WriteCover: true, KeepAudioOnMetadataFailure: keep, Metadata: &DownloadMetadata{Title: "new title", CoverURL: coverURL}}
				j := downloadStart(t, a, ctx, epoch, c, req)
				downloadWait(t, j)
				st, _ := c.access(a.state, ctx, epoch, req.OperationID, false)
				if st.Committed != keep || len(st.Issues) != 1 || st.Issues[0].Stage != "cover" {
					t.Fatalf("cover result: %+v", st)
				}
				if kind == "http" && st.Issues[0].HTTPStatus != 404 {
					t.Fatalf("missing HTTP reason: %+v", st)
				}
				if keep {
					data, err := os.ReadFile(filepath.Join(dir, "song.mp3"))
					if err != nil {
						t.Fatal(err)
					}
					info, err := metadata.Parse(bytes.NewReader(data), int64(len(data)))
					if err != nil || st.Code != "ok" || info.Title != "new title" || len(info.Pictures) != 0 {
						t.Fatalf("lost text tags: %+v %v", info, err)
					}
				}
				assertDownloadClean(t, dir)
			})
		}
	}
}

func TestDownloadOptionalSidecarsKeepSuccessfulFiles(t *testing.T) {
	for _, operation := range []string{"write", "publish"} {
		t.Run(operation, func(t *testing.T) {
			a, ctx, epoch, c, token, dir := downloadFixture(t)
			req := nativeTestRequest(t, c, token)
			req.Options.KeepAudioOnMetadataFailure = true
			req.Options.WriteCover = true
			req.Options.Metadata.CoverURL = "https://cover.invalid/image"
			var jpg bytes.Buffer
			if err := jpeg.Encode(&jpg, image.NewRGBA(image.Rect(0, 0, 2, 2)), nil); err != nil {
				t.Fatal(err)
			}
			c.client.Transport = downloadRoundTripper(func(r *http.Request) (*http.Response, error) {
				if r.URL.Host == "cover.invalid" {
					return downloadResponse(jpg.Bytes(), int64(jpg.Len())), nil
				}
				data := downloadMP3()
				return downloadResponse(data, int64(len(data))), nil
			})
			failures := 0
			c.io.Before = func(kind, op string) error {
				if kind == "sidecar" && op == operation {
					failures++
					if failures == 1 {
						return syscall.ENOSPC
					}
				}
				return nil
			}
			j := downloadStart(t, a, ctx, epoch, c, req)
			downloadWait(t, j)
			st, _ := c.access(a.state, ctx, epoch, req.OperationID, false)
			if !st.Committed || st.Ref == nil || st.Code != "ok" || len(st.Issues) != 1 || st.Issues[0].Reason != "disk_full" || st.Issues[0].Stage != "lyrics_file" {
				t.Fatalf("sidecar failure rejected audio: %+v", st)
			}
			if _, err := os.Stat(filepath.Join(dir, "Artist/Album/song.jpg")); err != nil {
				t.Fatalf("remaining cover sidecar was not saved: %v", err)
			}
			if _, err := os.Stat(filepath.Join(dir, "Artist/Album/song.lrc")); !os.IsNotExist(err) {
				t.Fatalf("failed lyrics sidecar was published: %v", err)
			}
			assertDownloadClean(t, filepath.Join(dir, "Artist/Album"))
		})
	}
}

func TestDownloadKeepAudioStillRejectsFatalFailures(t *testing.T) {
	for _, failure := range []string{"invalid_audio", "restore", "sync", "cancel"} {
		t.Run(failure, func(t *testing.T) {
			a, ctx, epoch, c, token, dir := downloadFixture(t)
			data := downloadMP3()
			if failure == "invalid_audio" {
				data = []byte("not audio")
			}
			c.client.Transport = downloadRoundTripper(func(*http.Request) (*http.Response, error) { return downloadResponse(data, int64(len(data))), nil })
			req := downloadReq(t, token, "song.mp3")
			req.Options = &DownloadOptions{WriteMetadata: true, KeepAudioOnMetadataFailure: true, Metadata: &DownloadMetadata{Title: "title"}}
			c.io.Before = func(kind, operation string) error {
				if failure == "restore" && kind == "metadata" && operation == "edit" {
					if err := corruptDownloadWork(dir, true); err != nil {
						return err
					}
					return mtag.ErrContainerWriteUnsupported
				}
				if kind == "work" && operation == failure {
					return errors.New("injected failure")
				}
				if failure == "cancel" && kind == "metadata" && operation == "edit" {
					_, err := c.access(a.state, ctx, epoch, req.OperationID, true)
					return err
				}
				return nil
			}
			j := downloadStart(t, a, ctx, epoch, c, req)
			downloadWait(t, j)
			st, _ := c.access(a.state, ctx, epoch, req.OperationID, false)
			if st.Committed || st.Ref != nil || st.Code == "ok" {
				t.Fatalf("fatal failure downgraded: %+v", st)
			}
			if _, err := os.Stat(filepath.Join(dir, "song.mp3")); !os.IsNotExist(err) {
				t.Fatalf("unsafe audio published: %v", err)
			}
		})
	}
}
