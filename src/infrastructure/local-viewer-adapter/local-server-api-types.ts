/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// PUBLIC WIRE TYPES for the local trace-viewer HTTP server.
//
// Re-exported via the `./local-server-api` subpath:
//
//   import type { TraceResponse, ExecJobSnapshot }
//     from '@heal-dev/heal-playwright-tracer/local-server-api';
//
// Consumed by heal-frontend's trace-viewer-standalone (which renders
// the SPA bundled back into this repo) and by heal-cli (when it
// introspects a running local viewer). Any non-additive change to a
// type below is a BREAKING change for those consumers and requires a
// coordinated version bump.
//
// Domain types referenced in the wire format are re-exported from
// this module so consumers need only one import.

import type { TestStatus } from '../../domain/persistence/test-status';
import { HEAL_TRACE_SCHEMA_VERSION } from '../../domain/trace-event-recorder/model/statement-trace-schema';
import type {
  Statement,
  StatementError,
  StatementErrorCause,
  TestAttachment,
  TestContext,
  TestEnv,
  TestHeader,
  TestResultRecord,
  TestSourceFile,
} from '../../domain/trace-event-recorder/model/statement-trace-schema';

export type {
  Statement,
  StatementError,
  StatementErrorCause,
  TestAttachment,
  TestContext,
  TestEnv,
  TestHeader,
  TestResultRecord,
  TestSourceFile,
  TestStatus,
};

export { HEAL_TRACE_SCHEMA_VERSION };

// ─── /api/executions ───────────────────────────────────────────────

export interface ExecutionTotals {
  tests: number;
  passed: number;
  failed: number;
  timedOut: number;
  skipped: number;
  interrupted: number;
}

export interface ExecutionGit {
  sha?: string;
  branch?: string;
  dirty?: boolean;
}

export interface ExecutionSummary {
  executionId: string;
  source?: 'env' | 'generated';
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  totals?: ExecutionTotals;
  git?: ExecutionGit;
  playwrightVersion?: string;
}

export interface ExecutionsResponse {
  executions: ExecutionSummary[];
}

// ─── /api/executions/:executionId/index.json ───────────────────────

export interface TestSummary {
  /**
   * Compound `${playwrightTestId}_${attempt}` routing key. The SPA
   * splits on the LAST underscore so test ids that themselves contain
   * underscores round-trip correctly.
   */
  id: string;
  playwrightTestId: string;
  /** 1-indexed. */
  attempt: number;
  /** NDJSON path relative to `<rootDir>/heal-traces/<executionId>/`. */
  ndjsonPath: string;
  title: string;
  titlePath: string[];
  file: string;
  project: string;
  status: TestStatus;
  duration: number;
  startedAt: number;
  /**
   * All Playwright attachments. Empty when the optional
   * HealTracerReporter isn't registered; absence is not an error.
   * Videos are NOT a separate channel — filter on
   * `contentType.startsWith('video/')` to derive them.
   */
  attachments: TestAttachment[];
  /**
   * True when the per-attempt `analyze.ndjson` exists and contains a
   * terminal `verdict` event. Terminal `error` events (system issues)
   * do NOT count — those are retryable and should still appear in
   * "Analyze all" candidate lists. Computed fresh on each
   * `/index.json` request (not cached) so newly-completed analyses
   * show up without restarting the viewer.
   */
  hasAnalyzeVerdict: boolean;
}

export interface IndexResponse {
  schemaVersion: number;
  executionId: string;
  tests: TestSummary[];
}

// ─── /api/executions/:executionId/tests/:playwrightTestId/:attempt ─

/**
 * Wire-side attachment reference. Identical to the on-disk
 * `TestAttachment` plus an absolute `url` the server stamps in so
 * the SPA can fetch the file without knowing the on-disk layout.
 */
export interface AttachmentRef {
  url: string;
  name: string;
  path: string;
  contentType: string;
}

/**
 * Wire-side source-file reference. Carries the manifest fields from
 * `TestSourceFile` plus an absolute `url` the SPA can fetch to read
 * the file's full content. The server resolves URLs against the
 * `/api/executions/:executionId/source/:testId/:attempt/...` endpoint;
 * `truncated: true` entries point at a non-existent file (the capture
 * step skipped copy due to size) and the fetch will 404 — clients
 * should branch on the flag before fetching.
 */
export interface SourceRef {
  url: string;
  path: string;
  bytes: number;
  entry?: boolean;
  truncated?: boolean;
}

export interface TraceResponse {
  header: TestHeader;
  /**
   * Statements with their `screenshot` field rewritten by the server
   * from an on-disk filename to an absolute `/api/.../screenshot/...`
   * URL. The TS type is the same `Statement` shape — only the
   * runtime meaning of `screenshot` shifts.
   */
  statements: Statement[];
  result?: TestResultRecord;
  attachments: AttachmentRef[];
  /**
   * Source-file manifest entries for the test — the spec file plus
   * every user file it transitively imports. Empty when source
   * capture was not enabled at run time. Each `url` resolves to the
   * file's full content via the source endpoint.
   */
  source: SourceRef[];
}

// ─── /api/exec ─────────────────────────────────────────────────────

export interface ExecRequestBody {
  bin: string;
  args: string[];
}

export interface ExecSpawnResponse {
  jobId: string;
}

export type ExecJobStatus = 'running' | 'exited';

export interface ExecJobSnapshot {
  jobId: string;
  status: ExecJobStatus;
  exitCode: number | null;
  stdout: string[];
  stderr: string[];
}

// ─── /api/executions/:executionId/tests/:playwrightTestId/:attempt/analyze ─
//
// Analyze-side wire types live in their own self-contained file because
// they are vendored 1:1 into heal-frontend's trace-viewer-standalone
// (see `analyze-wire-types.ts` for the rationale). Re-exported here so
// `./local-server-api` consumers (heal-cli) see no API change.

export type {
  AnalyzeVerdictType,
  AnalyzeVerdict,
  AnalyzeEvent,
  AnalyzeRunStatus,
  AnalyzeRunStartResponse,
} from './analyze-wire-types';
export { ANALYZE_NDJSON_FILENAME } from './analyze-wire-types';

// ─── Errors ────────────────────────────────────────────────────────

export interface ApiErrorResponse {
  error: string;
}
