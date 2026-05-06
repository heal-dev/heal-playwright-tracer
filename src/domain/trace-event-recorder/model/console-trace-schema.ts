/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Output schema for `heal-console.ndjson` — the sidecar stream
// carrying browser-page console messages and uncaught page errors
// that fired during a test.
//
// One record per line. Records appear in event-fire order across
// every page wired to the BrowserContext (initial page + popups +
// any page in a context the user opened via `browser.newContext()`).
//
// Cross-link to `heal-traces.ndjson`:
//   - `t` is ms since the recorder's `startedAt` (same origin used
//     by every other Heal record, so a viewer can interleave the
//     two streams on a single timeline without clock skew).
//   - `statementSeq?` is the `seq` of the enter event on top of the
//     active-enter stack at emit time, or omitted when the event
//     fired outside any instrumented statement (between tests, in a
//     fixture hook, in a popup created by the test but still warming
//     up while no statement is active, …).
//   - `stepPath?` is denormalized from the recorder's step stack so
//     viewers can group/filter by `test.step(...)` without joining
//     against the statement stream.
//   - `pageUrl?` and `frameUrl?` are denormalized from
//     `page.url()` / `frame.url()` at emit time so the record stays
//     useful even when the page later navigates away.

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace' | 'pageerror';

export interface ConsoleLocation {
  url?: string;
  line?: number;
  col?: number;
}

export interface ConsoleRecord {
  kind: 'console';
  /** Milliseconds since the recorder's `startedAt` for this test. */
  t: number;
  /** Top-of-enter-stack `seq` at emit time, or absent if the event fired outside any instrumented statement. */
  statementSeq?: number;
  /** Full chain of enclosing `test.step(...)` titles, snapshot at emit time. */
  stepPath?: string[];
  level: ConsoleLevel;
  /** `ConsoleMessage.text()` for `console.*`, `Error.message` for `pageerror`. */
  text: string;
  /**
   * Best-effort `ConsoleMessage.args().jsonValue()` for `console.*`
   * (each handle resolved with a small per-arg timeout, then capped
   * by the configured `maxArgBytes` / `maxArgsPerEvent`). Absent for
   * `pageerror` and when arg resolution timed out.
   */
  args?: unknown[];
  /** Stack from `Error` objects passed to `pageerror`. Absent for `console.*`. */
  stack?: string;
  /** Source location reported by `ConsoleMessage.location()`. */
  location?: ConsoleLocation;
  pageUrl?: string;
  frameUrl?: string;
}
