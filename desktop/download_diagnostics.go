package main

import (
	"crypto/tls"
	"errors"
	"fmt"
	"log"
	"net"
	"strings"
	"syscall"

	"github.com/he-music/HE-Music/desktop/metadata"
	"github.com/tommyo123/mtag"
)

// Never log the request URL, selected path, operation token or raw error text.
// The stage, status and OS error number identify failures without credentials.
func downloadFailureMessage(stage string, status int, cause error, state DownloadState) string {
	switch state.Code {
	case "ok", "durability_uncertain", "cancelled", "revoked":
		return ""
	}
	var number syscall.Errno
	_ = errors.As(cause, &number)
	kind := "none"
	if cause != nil {
		leaf := cause
		for depth := 0; depth < 8; depth++ {
			next := errors.Unwrap(leaf)
			if next == nil {
				break
			}
			leaf = next
		}
		kind = fmt.Sprintf("%T", leaf)
		var certificate *tls.CertificateVerificationError
		var dns *net.DNSError
		var network net.Error
		switch {
		case errors.As(cause, &certificate):
			kind = "tls_certificate"
		case errors.As(cause, &dns):
			kind = "dns"
		case errors.As(cause, &network) && network.Timeout():
			kind = "timeout"
		}
		if payloadKind := downloadPayloadFailureReason(cause); payloadKind != "" {
			kind = payloadKind
		}
	}
	return fmt.Sprintf("download failed: code=%s stage=%s http_status=%d os_code=%d received=%d total=%d committed=%t cause=%s",
		state.Code, stage, status, number, state.Received, state.Total, state.Committed, kind)
}

func logDownloadFailure(stage string, status int, cause error, state DownloadState) {
	if message := downloadFailureMessage(stage, status, cause, state); message != "" {
		log.Print(message)
	}
}

// Only return fixed diagnostic codes. Parser errors may contain private source
// details, so their original text must never be written to logs.
func downloadPayloadFailureReason(cause error) string {
	switch {
	case errors.Is(cause, mtag.ErrUnsupportedFormat):
		return "unrecognized_audio_format"
	case errors.Is(cause, mtag.ErrInvalidTag):
		return "invalid_audio_tags"
	case errors.Is(cause, mtag.ErrUnsupportedVersion):
		return "unsupported_audio_tag_version"
	case errors.Is(cause, mtag.ErrFileTooLarge):
		return "audio_parser_size_limit"
	case errors.Is(cause, metadata.ErrAudioPayloadChanged):
		return "audio_payload_changed"
	}
	unsupported := errors.Is(cause, metadata.ErrUnsupportedPayload)
	invalid := errors.Is(cause, metadata.ErrInvalidPayload)
	if !unsupported && !invalid {
		return ""
	}
	message := cause.Error()
	for _, reason := range []struct{ detail, code string }{
		{"FLAC metadata type", "flac_metadata_type"},
		{"too many FLAC metadata blocks", "flac_metadata_block_limit"},
		{"FLAC blocking strategy change", "flac_blocking_strategy"},
		{"trailing FLAC bytes", "flac_trailing_bytes"},
		{"ID3 version", "mp3_id3_version"},
		{"ID3 flags", "mp3_id3_flags"},
		{"ID3 reserved flags", "mp3_id3_reserved_flags"},
		{"ID3 footer", "mp3_id3_footer"},
		{"non-synchsafe ID3 size", "mp3_id3_size"},
		{"unknown MPEG/trailing bytes", "mp3_unknown_prefix_or_trailer"},
		{"CRC-protected MPEG", "mp3_crc_protection"},
		{"MPEG bit reservoir", "mp3_bit_reservoir"},
		{"MPEG side information", "mp3_side_information"},
		{"Xing frame/byte count", "mp3_xing_counts"},
		{"VBRI", "mp3_vbri"},
		{"truncated/short MPEG frame", "mp3_frame_length"},
		{"changing MPEG stream", "mp3_stream_change"},
	} {
		if strings.Contains(message, "audio payload layout: "+reason.detail) || strings.Contains(message, "invalid audio payload: "+reason.detail) {
			return reason.code
		}
	}
	if unsupported {
		return "unsupported_audio_layout"
	}
	return "invalid_audio_layout"
}
