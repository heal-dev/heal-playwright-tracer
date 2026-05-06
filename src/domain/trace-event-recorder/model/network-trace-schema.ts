/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Output schema for `heal-network.ndjson` — the sidecar stream
// carrying one record per HTTP exchange that fired during a test.
//
// Records are coalesced: the network adapter merges Playwright's
// `request` + `response` + `requestfinished`/`requestfailed` events
// into a single `NetworkRecord` on completion. This keeps the file
// one-row-per-exchange so a viewer doesn't have to do that join.
//
// Cross-link to `heal-traces.ndjson`:
//   - `t` is ms since the recorder's `startedAt` (same origin as the
//     statement stream).
//   - `statementSeq?` is the top-of-enter-stack `seq` at the moment
//     the request was issued — the same correlation key used by
//     locator screenshots, so a viewer can attribute every HTTP
//     exchange to the statement that triggered it without timing
//     heuristics.
//   - `stepPath?`, `pageUrl?`, `frameUrl?` are denormalized so a
//     viewer can group by step or origin without joining streams.
//
// Body capture is policy-driven (see `application/heal-config`):
//   - `bodyMode: 'always'` — text/json bodies under `maxBodyBytes`
//     are inlined as `requestBody.preview` / `responseBody.preview`.
//   - `bodyMode: 'on-error'` — bodies are buffered in memory while
//     the test runs and flushed as `NetworkBodyRecord` lines AFTER
//     `test-result` if the test failed; discarded otherwise. The
//     `network` record itself never carries the body in this mode.
//   - `bodyMode: 'never'` — bodies are never read; only `bytes` is
//     populated when known via `Content-Length`.
//
// Header redaction (case-insensitive) applies to BOTH request and
// response headers and runs before any record is written.

export interface NetworkTiming {
  /** Ms since `request.timing().startTime`, mirroring Playwright's `RequestTiming` shape. */
  startTime?: number;
  domainLookupStart?: number;
  domainLookupEnd?: number;
  connectStart?: number;
  secureConnectionStart?: number;
  connectEnd?: number;
  requestStart?: number;
  responseStart?: number;
  responseEnd?: number;
}

export interface NetworkSecurityDetails {
  protocol?: string;
  subjectName?: string;
  issuer?: string;
  /** Unix timestamp in seconds. */
  validFrom?: number;
  validTo?: number;
}

export interface NetworkServerAddr {
  ipAddress?: string;
  port?: number;
}

export interface NetworkBodyPreview {
  /** Total body size when known (from Content-Length or buffer length). */
  bytes?: number;
  /** True when `preview` is shorter than `bytes` because the cap was hit. */
  truncated: boolean;
  /**
   * UTF-8 preview of the body. Present only for textual content
   * types (`text/*`, `application/json`, `application/xml`,
   * `application/x-www-form-urlencoded`, …) AND when reading
   * succeeded within the timeout. Trimmed at a safe UTF-8 boundary
   * to avoid mid-codepoint cuts.
   */
  preview?: string;
}

export interface NetworkFailure {
  errorText: string;
}

export type NetworkSource = 'browser-context' | 'api-request-context';

export interface NetworkRecord {
  kind: 'network';
  /** Ms since the recorder's `startedAt`, sampled when the request was issued. */
  t: number;
  statementSeq?: number;
  stepPath?: string[];
  /**
   * Per-test stable id for this exchange. Synthesized by the adapter
   * (Playwright does not expose a request id), shared with any
   * follow-up `network-body` record so the two can be joined.
   */
  requestId: string;
  /** Where the exchange came from. `'api-request-context'` is the runner-side `playwright.request` traffic. */
  source: NetworkSource;
  method: string;
  url: string;
  /**
   * Playwright `Request.resourceType()` for browser-context traffic
   * (`'document'|'fetch'|'xhr'|'image'|...`). Absent for
   * api-request-context traffic, which has no equivalent.
   */
  resourceType?: string;
  isNavigationRequest?: boolean;
  /** Set when this request was reached via one or more redirects. */
  redirectedFromId?: string;

  status?: number;
  statusText?: string;
  fromServiceWorker?: boolean;

  requestHeaders: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: NetworkBodyPreview;
  responseBody?: NetworkBodyPreview;

  timing?: NetworkTiming;
  serverAddr?: NetworkServerAddr;
  securityDetails?: NetworkSecurityDetails;
  failure?: NetworkFailure;

  pageUrl?: string;
  frameUrl?: string;

  /** Total ms between request issue and response end / failure. */
  duration?: number;
}

/**
 * Optional record appended AFTER the matching `NetworkRecord` (and
 * after `test-result` in the main file's mental timeline) when the
 * configured body capture mode is `'on-error'` and the test failed.
 *
 * Carrying the body on a separate line keeps the live network stream
 * line-by-line during the test — bodies are buffered in memory and
 * flushed only when we decide to keep them.
 *
 * Joined to its parent `NetworkRecord` via `requestId`.
 */
export interface NetworkBodyRecord {
  kind: 'network-body';
  requestId: string;
  requestBody?: NetworkBodyPreview;
  responseBody?: NetworkBodyPreview;
}
