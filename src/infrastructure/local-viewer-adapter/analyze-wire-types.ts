/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Analyze-side wire types: the contract between `heal analyze` (writes
// `analyze.ndjson`), the local viewer HTTP server (projects it for the
// SPA), and the standalone SPA (renders the verdict).
//
// This file is intentionally SELF-CONTAINED — no imports from elsewhere
// in the tracer source tree. It is vendored verbatim into
// `heal-frontend/packages/trace-viewer-standalone/src/vendor/heal-tracer-api-types.ts`
// at build time by `scripts/refresh-viewer-bundle.js`, so the standalone
// can typecheck against the same contract without a `file:` dependency on
// the tracer tarball (which previously broke Vercel installs of
// heal-frontend, since the tarball only exists on contributors' machines).
//
// All exports are also re-exported from `./local-server-api-types.ts`, so
// non-vendored consumers (heal-cli) keep importing them from the
// `./local-server-api` subpath without any code change.

/**
 * Filename `heal analyze` writes inside the per-test attempt directory
 * (`heal-traces/<executionId>/<playwrightTestId>/<attempt>/`). Exposed
 * here so heal-cli can import the same constant rather than hardcoding
 * it on both sides of the contract.
 */
export const ANALYZE_NDJSON_FILENAME = 'analyze.ndjson';

/**
 * Verdict types the LLM can emit. `HEAL_SYSTEM_ISSUE` is intentionally
 * absent: a system failure (timeout, network, crash) surfaces as an
 * `{event:'error',…}` line in the NDJSON, not a verdict.
 */
export type AnalyzeVerdictType =
  | 'BUG'
  | 'UI_CHANGED'
  | 'UNSTABLE_LOCATOR'
  | 'BROKEN_TEST_LOGIC'
  | 'NO_VERDICT';

export interface AnalyzeVerdict {
  verdictType: AnalyzeVerdictType;
  /** 0-based index into the trace's `statements[]`. */
  failingStatementIndex: number;
  description: string;
  reasoning?: string;
  fixRecommended?: string;
  /** Model id (e.g. `'opus-4.6-high'`). */
  model?: string;
  latencyMs?: number;
}

/**
 * One line in `analyze.ndjson`. `started` is informational; the run
 * is terminal on the first `verdict` or `error` event.
 */
export type AnalyzeEvent =
  | { event: 'started'; timestamp: number }
  | { event: 'verdict'; verdict: AnalyzeVerdict; timestamp: number }
  | { event: 'error'; message: string; timestamp: number };

/**
 * Tracer-side projection of `analyze.ndjson` for the SPA. The tracer
 * is the only thing that parses the on-disk NDJSON — consumers see
 * this typed discriminated union instead.
 */
export type AnalyzeRunStatus =
  | { status: 'running' }
  | { status: 'completed'; verdict: AnalyzeVerdict; events: AnalyzeEvent[] }
  | { status: 'failed'; message: string; events: AnalyzeEvent[] };

export interface AnalyzeRunStartResponse {
  jobId: string;
}
