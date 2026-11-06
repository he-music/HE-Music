package main

import (
	"context"
	"errors"
	"fmt"
	"image"
	"net"
	"os"
	"slices"
	"syscall"

	"github.com/tommyo123/mtag"

	"github.com/he-music/HE-Music/desktop/metadata"
)

// DownloadIssue carries fixed, localizable codes rather than raw errors or URLs.
type DownloadIssue struct {
	Stage      string `json:"stage"`
	Reason     string `json:"reason"`
	HTTPStatus int    `json:"httpStatus,omitzero"`
}

type downloadHTTPError struct{ status int }

func (e downloadHTTPError) Error() string { return fmt.Sprintf("download HTTP status %d", e.status) }

var (
	errDownloadCoverUnavailable = errors.New("download cover unavailable")
	errDownloadCoverLimit       = errors.New("download cover resource limit")
	errDownloadMetadataReadback = errors.New("download metadata readback mismatch")
)

type downloadCoverError struct{ error }

func (e downloadCoverError) Unwrap() error { return e.error }

func downloadIssue(stage string, cause error, code string) DownloadIssue {
	issue := DownloadIssue{Stage: stage, Reason: downloadIssueReason(cause, code)}
	if _, cover := errors.AsType[downloadCoverError](cause); cover {
		issue.Stage = "cover"
	}
	if httpErr, ok := errors.AsType[downloadHTTPError](cause); ok && httpErr.status >= 100 && httpErr.status <= 599 {
		issue.HTTPStatus = httpErr.status
	}
	return issue
}

func downloadIssueReason(cause error, code string) string {
	switch {
	case errors.Is(cause, errDownloadCoverUnavailable):
		return "cover_unavailable"
	case errors.Is(cause, errDownloadCoverLimit):
		return "resource_limit"
	case errors.Is(cause, errDownloadMetadataReadback):
		return "tag_readback_mismatch"
	case errors.Is(cause, image.ErrFormat):
		return "invalid_image"
	case errors.Is(cause, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(cause, os.ErrPermission):
		return "permission_denied"
	case errors.Is(cause, syscall.ENOSPC):
		return "disk_full"
	case errors.Is(cause, os.ErrExist):
		return "file_exists"
	case errors.Is(cause, metadata.ErrAudioPayloadChanged):
		return "audio_payload_changed"
	case errors.Is(cause, mtag.ErrContainerWriteUnsupported), errors.Is(cause, metadata.ErrUnsupportedContainer):
		return "tag_write_unsupported"
	}
	if reason := downloadPayloadFailureReason(cause); reason != "" {
		return reason
	}
	if _, ok := errors.AsType[downloadHTTPError](cause); ok {
		return "http_rejected"
	}
	if network, ok := errors.AsType[net.Error](cause); ok {
		if network.Timeout() {
			return "timeout"
		}
		return "network_error"
	}
	switch code {
	case "unsupported":
		return "format_mismatch"
	case "cleanup_failed", "sync_failed", "registration_failed", "atomic_commit_failed":
		return code
	case "payload_rejected":
		return "invalid_audio_layout"
	case "network_error", "http_rejected", "timeout", "conflict":
		return code
	default:
		return "write_failed"
	}
}

func (t *downloadTransfer) addIssue(stage string, cause error, code string) {
	issue := downloadIssue(stage, cause, code)
	if slices.Contains(t.out.Issues, issue) {
		return
	}
	if len(t.out.Issues) < 8 {
		t.out.Issues = append(t.out.Issues, issue)
	}
}

func (t *downloadTransfer) keepAudio() bool {
	return t.job.options != nil && t.job.options.KeepAudioOnMetadataFailure
}

func (t *downloadTransfer) optionalFailure(stage string, cause error) error {
	if err := t.job.ctx.Err(); err != nil {
		return err
	}
	if !t.keepAudio() {
		return cause
	}
	t.addIssue(stage, cause, "")
	t.out.Code = "io_error"
	return nil
}

func (t *downloadTransfer) finish(cause error) {
	logDownloadFailure(t.stage, t.status, cause, *t.out)
	switch t.out.Code {
	case "ok", "durability_uncertain", "cancelled", "revoked":
		return
	}
	stage := "audio"
	switch t.stage {
	case "copy_source", "edit_metadata", "verify_metadata":
		stage = "metadata"
	case "prepare_sidecars", "publish_sidecars":
		stage = "sidecar"
	}
	t.addIssue(stage, cause, t.out.Code)
}
