/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Pure body-preview helpers for the network adapter. Two policies live
// here: which content types are eligible for inlined preview (textual
// payloads only — buffering megabytes of binary into NDJSON is never
// worth it) and how to truncate a `Buffer` at a safe UTF-8 boundary.

import type { NetworkBodyPreview } from '../../domain/trace-event-recorder/model/network-trace-schema';

export const DEFAULT_TEXTUAL_CONTENT_TYPES: readonly RegExp[] = Object.freeze([
  /^text\//i,
  /^application\/json\b/i,
  /^application\/(?:[\w.+-]+\+)?xml\b/i,
  /^application\/x-www-form-urlencoded\b/i,
  /^application\/javascript\b/i,
  /^application\/graphql\b/i,
]);

/**
 * Decide whether a `Content-Type` header maps to a textual body that
 * can be safely inlined as a UTF-8 preview. Anything else (images,
 * video, octet-stream, application/zip) returns `false`.
 *
 * Allowlist may be `undefined` to mean "use defaults". An empty array
 * means "no content type is allowed" — useful for users who want
 * `bytes`-only records.
 */
export function isTextualContentType(
  contentType: string | undefined,
  allowlist: readonly RegExp[] | undefined,
): boolean {
  if (!contentType) return false;
  const list = allowlist ?? DEFAULT_TEXTUAL_CONTENT_TYPES;
  return list.some((re) => re.test(contentType));
}

/**
 * Trim a `Buffer` to at most `maxBytes` and decode as UTF-8 without
 * cutting through a multi-byte codepoint. Walks back from the cap to
 * the most recent leading byte, then keeps the codepoint only if all
 * of its continuation bytes fall within the slice — otherwise the
 * codepoint is dropped entirely. Avoids the `�` replacement
 * characters Node would emit for a mid-codepoint cut.
 */
export function utf8SafeSlice(buf: Buffer, maxBytes: number): string {
  const end = Math.min(buf.length, maxBytes);
  if (end === 0) return '';

  // Walk back to the leading byte of the last codepoint touched by
  // the slice. Continuation bytes have the bit pattern 10xxxxxx;
  // every other top-2-bit pattern (00, 11) is a starter.
  let leadingIdx = end - 1;
  while (leadingIdx > 0 && (buf[leadingIdx] & 0xc0) === 0x80) {
    leadingIdx--;
  }

  const leadingByte = buf[leadingIdx];
  let codepointBytes: number;
  if ((leadingByte & 0x80) === 0) {
    codepointBytes = 1; // 0xxxxxxx — ASCII
  } else if ((leadingByte & 0xe0) === 0xc0) {
    codepointBytes = 2; // 110xxxxx
  } else if ((leadingByte & 0xf0) === 0xe0) {
    codepointBytes = 3; // 1110xxxx
  } else if ((leadingByte & 0xf8) === 0xf0) {
    codepointBytes = 4; // 11110xxx
  } else {
    codepointBytes = 1; // invalid leading byte; treat as one-byte unit
  }

  const codepointEnd = leadingIdx + codepointBytes;
  // If the codepoint extends past our cap, drop it; otherwise keep
  // every byte we have, which now includes a complete final codepoint.
  const cut = codepointEnd <= end ? end : leadingIdx;
  return buf.toString('utf8', 0, cut);
}

/**
 * Build a `NetworkBodyPreview` from a `Buffer`. The buffer is
 * truncated at `maxBodyBytes` if larger; `bytes` reports the total,
 * `truncated` flips when the cap was hit, and `preview` carries the
 * UTF-8 view (only when the content type was already deemed textual).
 *
 * `decodeAsText: false` means the caller already knows the body is
 * binary and just wants size accounting — this returns the preview
 * with `bytes` set and no `preview` string.
 */
export function previewBody(
  buf: Buffer,
  maxBodyBytes: number,
  decodeAsText: boolean,
): NetworkBodyPreview {
  const bytes = buf.length;
  const truncated = bytes > maxBodyBytes;
  const preview = decodeAsText ? utf8SafeSlice(buf, maxBodyBytes) : undefined;
  return {
    bytes,
    truncated,
    ...(preview !== undefined ? { preview } : {}),
  };
}

/**
 * Helper used by the adapter when only `Content-Length` is available
 * (e.g. body capture is `'never'`). Records the size without ever
 * reading the buffer.
 */
export function bytesOnlyPreview(bytes: number | undefined): NetworkBodyPreview | undefined {
  if (bytes === undefined || Number.isNaN(bytes)) return undefined;
  return { bytes, truncated: false };
}
