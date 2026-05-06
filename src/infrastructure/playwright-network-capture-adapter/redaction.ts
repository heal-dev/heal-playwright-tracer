/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Pure header-redaction policy for the network adapter. Lives in its
// own module so the rules can be unit-tested without standing up a
// Playwright runtime.
//
// Matching is case-insensitive (HTTP header names are case-insensitive
// per RFC 7230 §3.2). The default denylist covers the common credential
// carriers; user-supplied entries are merged on top, NOT replaced, so
// users can extend without accidentally weakening the defaults.

export const DEFAULT_REDACT_HEADERS: readonly string[] = Object.freeze([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
]);

/** The marker we substitute for redacted header values. */
export const REDACTED_MARKER = '<redacted>';

/**
 * Apply the redaction policy to a header bag. Returns a fresh object;
 * the input is not mutated. Header names are preserved in their
 * original case for fidelity with what Playwright reports.
 */
export function redactHeaders(
  headers: Record<string, string>,
  extraDenylist?: readonly string[],
): Record<string, string> {
  const deny = new Set<string>(DEFAULT_REDACT_HEADERS.map((h) => h.toLowerCase()));
  if (extraDenylist) {
    for (const name of extraDenylist) deny.add(name.toLowerCase());
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = deny.has(name.toLowerCase()) ? REDACTED_MARKER : value;
  }
  return out;
}
