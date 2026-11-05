package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
	"syscall"
	"testing"

	"github.com/tommyo123/mtag"

	"github.com/he-music/HE-Music/desktop/metadata"
)

func TestDownloadFailureDiagnosticsOmitPrivateInputs(t *testing.T) {
	cause := &url.Error{
		Op: "Get", URL: "https://private.invalid/audio?token=SIGNED_SECRET",
		Err: &os.PathError{Op: "open", Path: "PRIVATE_DIRECTORY/PRIVATE_SONG", Err: syscall.Errno(5)},
	}
	state := DownloadState{OperationID: "PRIVATE_OPERATION", Code: "io_error", Filename: "PRIVATE_SONG", Received: 7, Total: 10}
	message := downloadFailureMessage("create_work_file", 0, cause, state)
	for _, private := range []string{"PRIVATE_", "SIGNED_SECRET", "https://", "token="} {
		if strings.Contains(message, private) {
			t.Fatalf("private data leaked: %s", message)
		}
	}
	for _, field := range []string{"code=io_error", "stage=create_work_file", "os_code=5", "received=7", "total=10", "committed=false", "cause=syscall.Errno"} {
		if !strings.Contains(message, field) {
			t.Fatalf("missing diagnostic %q: %s", field, message)
		}
	}
}

func TestDownloadFailureDiagnosticsSeparateNetworkFailures(t *testing.T) {
	for _, test := range []struct {
		name   string
		cause  error
		status int
		want   string
	}{
		{"HTTP", nil, 403, "http_status=403"},
		{"DNS", &url.Error{Err: &net.DNSError{Err: "PRIVATE_HOST", Name: "PRIVATE_HOST"}}, 0, "cause=dns"},
		{"certificate", &url.Error{Err: &tls.CertificateVerificationError{Err: errors.New("PRIVATE_CERTIFICATE")}}, 0, "cause=tls_certificate"},
		{"timeout", context.DeadlineExceeded, 0, "cause=timeout"},
	} {
		t.Run(test.name, func(t *testing.T) {
			message := downloadFailureMessage("fetch_audio", test.status, test.cause, DownloadState{Code: "network_error"})
			if !strings.Contains(message, test.want) || strings.Contains(message, "PRIVATE_") {
				t.Fatal(message)
			}
		})
	}
}

func TestDownloadFailureDiagnosticsSkipExpectedOutcomes(t *testing.T) {
	for _, code := range []string{"ok", "durability_uncertain", "cancelled", "revoked"} {
		if message := downloadFailureMessage("sync_directory", 200, fmt.Errorf("PRIVATE_ERROR"), DownloadState{Code: code}); message != "" {
			t.Fatalf("expected outcome was logged as a failure: %s", message)
		}
	}
}

func TestDownloadPayloadFailureReasonsAreFixedCodes(t *testing.T) {
	for _, test := range []struct {
		cause error
		want  string
	}{
		{fmt.Errorf("PRIVATE_SOURCE: %w: FLAC metadata type 7", metadata.ErrUnsupportedPayload), "flac_metadata_type"},
		{fmt.Errorf("PRIVATE_SOURCE: %w: too many FLAC metadata blocks", metadata.ErrUnsupportedPayload), "flac_metadata_block_limit"},
		{fmt.Errorf("PRIVATE_SOURCE: %w: FLAC blocking strategy change", metadata.ErrUnsupportedPayload), "flac_blocking_strategy"},
		{fmt.Errorf("PRIVATE_SOURCE: %w: trailing FLAC bytes", metadata.ErrUnsupportedPayload), "flac_trailing_bytes"},
		{fmt.Errorf("PRIVATE_SOURCE: %w: ID3 flags", metadata.ErrUnsupportedPayload), "mp3_id3_flags"},
		{fmt.Errorf("PRIVATE_SOURCE: %w: CRC-protected MPEG", metadata.ErrUnsupportedPayload), "mp3_crc_protection"},
		{fmt.Errorf("PRIVATE_SOURCE: %w: unknown MPEG/trailing bytes at 123", metadata.ErrUnsupportedPayload), "mp3_unknown_prefix_or_trailer"},
		{fmt.Errorf("PRIVATE_SOURCE: %w: Xing frame/byte count", metadata.ErrInvalidPayload), "mp3_xing_counts"},
		{fmt.Errorf("PRIVATE_SOURCE: %w", mtag.ErrUnsupportedFormat), "unrecognized_audio_format"},
		{fmt.Errorf("PRIVATE_SOURCE: %w", mtag.ErrInvalidTag), "invalid_audio_tags"},
	} {
		message := downloadFailureMessage("validate_audio", 200, test.cause, DownloadState{Code: "payload_rejected"})
		if !strings.Contains(message, "cause="+test.want) || strings.Contains(message, "PRIVATE_SOURCE") {
			t.Fatal(message)
		}
	}
}
