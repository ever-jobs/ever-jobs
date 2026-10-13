/**
 * Spec 5161 — raw HTTP capture for single-source debug runs.
 *
 * When `POST /api/jobs/search` is called with `include_raw=true`, every HTTP
 * attempt the selected source makes — through the shared axios client or the
 * browser pool — is recorded as a `RawHttpEntry` and returned under
 * `raw_by_source` on the response envelope.
 */

export interface RawHttpEntry {
  /** Per-sink sequence number, assigned when the attempt starts. */
  seq: number;
  /** Retry index (0-based). Always 0 for browser traffic — Playwright does not retry. */
  attempt: number;
  method: string;
  /** Credential-redacted request URL (first hop for redirect chains). */
  url: string;
  /** Last hop of a redirect chain; set only when it differs from `url`. */
  final_url?: string;
  /** HTTP status, or null when the request failed before a response. */
  status: number | null;
  error?: string;
  elapsed_ms: number;
  content_type?: string;
  /** JSON request bodies only, sensitive keys recursively redacted. */
  request_body?: unknown;
  /** Parsed JSON or text body; omitted for binary/stream payloads or on truncation. */
  body?: unknown;
  /** Original serialized body size in UTF-8 bytes, even when `body` is omitted. */
  body_bytes: number;
  truncated: boolean;
}

export interface RawCaptureSink {
  entries: RawHttpEntry[];
  /** Bytes retained across `entries` so far; capped by RAW_CAPTURE_MAX_SOURCE_BYTES. */
  retained_bytes: number;
  /** In-flight body reads (browser responses); drained before the sink is closed. */
  pending: Promise<void>[];
  /** Set once the response has shipped — late writes are dropped. */
  closed: boolean;
}
