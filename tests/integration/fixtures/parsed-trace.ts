/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */

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
