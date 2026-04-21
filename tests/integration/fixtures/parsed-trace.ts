/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 *
 */

// Shared helpers for integration assertions.
//
// `ParsedTrace` is the shape both sinks (DiskTraceSink, HttpTraceSink)
// expose: a single object per test, assembled from the stream of
// `HealTraceRecord` lines that the projector emits during the run.
//
// The shape collapses three record kinds into one navigable tree:
//
//   - `test-header`  → top-level fields (title, context, env, …)
//   - `statement`    → pushed onto `statements`, with `children` walked transparently
//   - `test-result`  → final status / duration / stdout / stderr
//
// Both sinks produce `Map<testTitle, ParsedTrace>` from this shape so
// the same `runScenarioAssertions` block can run against either.

import type {
  HealTraceRecord,
  Statement,
  StatementRecord,
  TestHeader,
  TestHeaderRecord,
  TestResultRecord,
} from '../../../src/domain/trace-event-recorder/model/statement-trace-schema';

export interface ParsedTrace {
  schemaVersion: number;
  test: TestHeader & {
    status: TestResultRecord['status'];
    duration: number;
    stdout?: string[];
    stderr?: string[];
  };
  /** Root statements, in emission order. Nested calls live in each statement's `children`. */
  statements: Statement[];
}

export function* walkStatements(
  roots: readonly Statement[],
  parent: Statement | null = null,
): Generator<{ stmt: Statement; parent: Statement | null }> {
  for (const stmt of roots) {
    yield { stmt, parent };
    yield* walkStatements(stmt.children, stmt);
  }
}

export function findStatement(
  trace: ParsedTrace,
  predicate: (stmt: Statement) => boolean,
): Statement | undefined {
  for (const { stmt } of walkStatements(trace.statements)) {
    if (predicate(stmt)) return stmt;
  }
  return undefined;
}

/**
 * Assemble a stream of `HealTraceRecord` lines (in emission order, all
 * belonging to one test run) into a `ParsedTrace`. Returns `null` when
 * no `test-header` is present — caller decides whether that's an
 * error.
 */
export function assembleTrace(records: readonly HealTraceRecord[]): ParsedTrace | null {
  let header: TestHeaderRecord | null = null;
  let result: TestResultRecord | null = null;
  const statements: Statement[] = [];

  for (const record of records) {
    switch (record.kind) {
      case 'test-header':
        header = record;
        break;
      case 'statement':
        statements.push((record as StatementRecord).statement);
        break;
      case 'test-result':
        result = record;
        break;
    }
  }

  if (!header) return null;

  return {
    schemaVersion: header.schemaVersion,
    test: {
      ...header.test,
      status: result?.status ?? 'interrupted',
      duration: result?.duration ?? 0,
      stdout: result?.stdout,
      stderr: result?.stderr,
    },
    statements,
  };
}
