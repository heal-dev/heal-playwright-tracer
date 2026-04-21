/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 *
 */

// Trace-schema — the typed shape of every event the recorder emits.
//
// `TraceEvent` is a discriminated union over the `type` field.
// Consumers within this package (event-builders, exporter adapters,
// active-enter stack) should use the concrete variants so TS narrows
// correctly. Anything that reads a generic event out of the exporter
// discriminates on `event.type` to recover the variant.
//
// This file is intentionally runtime-free — it contains only types
// and a re-exported `SerializedError` alias so the throw event's
// `error` field is typed end-to-end.

import type { SerializedError } from './serialized-error';

export type { SerializedError };

/** Fields common to every trace event. */
export interface TraceEventBase {
  seq: number;
  /** Milliseconds since the recorder's `startedAt` origin. */
  t: number;
  /** `Date.now()` at emit time. */
  wallTime: number;
}

/**
 * Emitted once per test at the top of the trace by `reset()`. Merges
 * the per-process static context (pid, gitSha, platform, …) and the
 * per-test dynamic context (workerIndex, testId, testTitle, …) as
 * extra keys. Known keys are listed explicitly; the index signature
 * is the escape hatch for context fields we haven't modelled yet.
 */
export interface MetaEvent extends TraceEventBase {
  type: 'meta';
  t: 0;
  // Static context (per-process).
  schemaVersion?: number;
  pid?: number;
  nodeVersion?: string;
  platform?: string;
  arch?: string;
  hostname?: string;
  isCI?: boolean;
  cwd?: string;
  gitSha?: string;
  // Dynamic context (per-test).
  workerIndex?: number;
  parallelIndex?: number;
  testId?: string;
  testTitle?: string;
  titlePath?: string[];
  projectName?: string;
  testFile?: string;
  retry?: number;
  // Correlation identifiers (per-test).
  runId?: string;
  attempt?: number;
  executionId?: string;
  testCaseId?: number;
  // Forward-compatible escape hatch.
  [key: string]: unknown;
}

/**
 * Emitted when a traced statement is about to run. Pushed onto the
 * active-enter stack and later paired with an ok or throw event.
 *
 * `screenshot` is mutated post-emit by
 * `setCurrentStatementScreenshot(filename)` — the locator-screenshots
 * feature calls that after capturing a highlight PNG, which stamps
 * the filename onto whichever enter event is currently on top of the
 * stack. The exporter stores events by reference, so the mutation is
 * visible when the builder reads snapshot() at teardown.
 */
export interface EnterEvent extends TraceEventBase {
  type: 'enter';
  parentSeq: number | null;
  depth: number;
  file: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  /** 'expression' | 'variable' | 'return' | 'throw' | 'break' | 'continue' | 'debugger' */
  kind: string;
  /** Enclosing function name or `test: <title>`. */
  scope: string;
  hasAwait: boolean;
  source: string;
  /**
   * User-written comments attached to this statement's source node.
   * See `Statement.leadingComment` for the attachment-ambiguity
   * caveats callers should know about.
   */
  leadingComment?: string;
  step: string | null;
  stepPath: string[] | null;
  pageUrl?: string;
  /** Highlight screenshot filename captured by locator-screenshots, if any. */
  screenshot?: string;
}

/**
 * Emitted when a traced statement finished without throwing. Matches
 * the topmost enter event on the stack.
 */
export interface OkEvent extends TraceEventBase {
  type: 'ok';
  enterSeq: number;
  duration: number;
  vars?: Record<string, unknown>;
}

/**
 * Emitted when a traced statement threw. `enterSeq` and `duration`
 * are zeroed out for the orphan case (error escaping the very first
 * instrumented statement, with no matching enter on the stack).
 */
export interface ThrowEvent extends TraceEventBase {
  type: 'throw';
  enterSeq: number | null;
  duration: number;
  error: SerializedError;
}

export type TraceEvent = MetaEvent | EnterEvent | OkEvent | ThrowEvent;

/**
 * Version stamped on every `MetaEvent.schemaVersion`. Bumped whenever
 * the raw trace-event stream shape changes in a backwards-incompatible
 * way. Separate from `HEAL_TRACE_SCHEMA_VERSION` in
 * `./statement-trace-schema.ts`, which versions the projected record
 * stream.
 */
export const SCHEMA_VERSION = 1;
