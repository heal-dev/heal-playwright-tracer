/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Schema for the persistent execution history written under
// `<rootDir>/heal-traces/`:
//
//   executions.ndjson  — append-only run index. One ExecutionRecord
//                        per line. Read by the local viewer to list
//                        runs without scanning every per-execution
//                        directory.
//   <executionId>/execution.json
//                      — per-execution manifest. ExecutionManifest
//                        carries the full per-test detail, written
//                        once on `onEnd`.
//
// Distinct from `statement-trace-schema.ts` (which describes the
// per-test NDJSON wire format) because these records are emitted by
// the reporter, not by the in-worker tracer, and capture cross-test
// run-level state.

import type { TestStatus } from './test-status';

/** Record kind — discriminator for executions.ndjson lines. */
export const EXECUTION_RECORD_KIND = 'execution' as const;

/**
 * One line in `executions.ndjson`. Compact per-run summary; full
 * per-test detail lives in `execution.json` next to its tests.
 */
export interface ExecutionRecord {
  kind: typeof EXECUTION_RECORD_KIND;
  executionId: string;
  /**
   * Whether the executionId came from `HEAL_EXECUTION_ID` (multi-shard
   * CI shares one id) or was generated locally per-process. Readers
   * use this to decide whether two records with the same id can
   * legitimately exist (yes when source='env').
   */
  source: 'env' | 'generated';
  startedAt: number;
  endedAt: number;
  durationMs: number;
  git?: {
    sha?: string;
    branch?: string;
    dirty?: boolean;
  };
  playwrightVersion?: string;
  totals: ExecutionTotals;
}

export interface ExecutionTotals {
  tests: number;
  passed: number;
  failed: number;
  timedOut: number;
  skipped: number;
  interrupted: number;
}

/**
 * Per-execution manifest written to
 * `<heal-traces>/<executionId>/execution.json`. Lets the viewer
 * build an execution-level page without parsing every NDJSON.
 */
export interface ExecutionManifest {
  executionId: string;
  source: 'env' | 'generated';
  startedAt: number;
  endedAt: number;
  durationMs: number;
  git?: {
    sha?: string;
    branch?: string;
    dirty?: boolean;
  };
  playwrightVersion?: string;
  totals: ExecutionTotals;
  tests: ExecutionTestEntry[];
}

export interface ExecutionTestEntry {
  playwrightTestId: string;
  title: string;
  titlePath: string[];
  file: string;
  project: string;
  attempt: number;
  status: TestStatus;
  durationMs: number;
  startedAt: number;
}
