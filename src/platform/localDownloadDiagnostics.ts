import type { DownloadIssue } from "./mygo.bindings";

const stages: readonly string[] = [
  "audio",
  "metadata",
  "cover",
  "sidecar",
  "lyrics_file",
  "cover_file",
];
const reasons: readonly string[] = [
  "cover_unavailable",
  "resource_limit",
  "tag_readback_mismatch",
  "invalid_image",
  "timeout",
  "permission_denied",
  "disk_full",
  "file_exists",
  "audio_payload_changed",
  "tag_write_unsupported",
  "http_rejected",
  "network_error",
  "format_mismatch",
  "invalid_audio_layout",
  "unsupported_audio_layout",
  "write_failed",
  "cleanup_failed",
  "sync_failed",
  "registration_failed",
  "atomic_commit_failed",
  "conflict",
  "unrecognized_audio_format",
  "invalid_audio_tags",
  "unsupported_audio_tag_version",
  "audio_parser_size_limit",
  "flac_metadata_type",
  "flac_metadata_block_limit",
  "flac_blocking_strategy",
  "flac_trailing_bytes",
  "mp3_id3_version",
  "mp3_id3_flags",
  "mp3_id3_reserved_flags",
  "mp3_id3_footer",
  "mp3_id3_size",
  "mp3_unknown_prefix_or_trailer",
  "mp3_crc_protection",
  "mp3_bit_reservoir",
  "mp3_side_information",
  "mp3_xing_counts",
  "mp3_vbri",
  "mp3_frame_length",
  "mp3_stream_change",
];

export function validDownloadIssues(value: unknown): value is readonly DownloadIssue[] {
  return (
    Array.isArray(value) &&
    value.length <= 8 &&
    value.every(
      (item: unknown) =>
        typeof item === "object" &&
        item !== null &&
        "stage" in item &&
        typeof item.stage === "string" &&
        stages.includes(item.stage) &&
        "reason" in item &&
        typeof item.reason === "string" &&
        reasons.includes(item.reason) &&
        (!("httpStatus" in item) ||
          (typeof item.httpStatus === "number" &&
            Number.isInteger(item.httpStatus) &&
            item.httpStatus >= 100 &&
            item.httpStatus <= 599)),
    )
  );
}

/** Discard unknown fields so diagnostics never persist URLs or native error text. */
export function copyDownloadIssues(issues: readonly DownloadIssue[]): readonly DownloadIssue[] {
  return issues.map(({ stage, reason, httpStatus }) => ({
    stage,
    reason,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
  }));
}
