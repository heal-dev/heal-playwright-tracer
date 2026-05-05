/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Reads one heal-traces.ndjson and projects it into the viewer model
// the SPA consumes via /api/trace/:id. The on-disk schema is one
// `HealTraceRecord` per non-empty line, in this order: header,
// statements, optional test-result. Missing terminator is treated as
// a partial trace, not an error — the worker may have crashed.

import { readFile } from 'node:fs/promises';

import type {
  Statement,
  TestAttachment,
  TestAttachmentsRecord,
  TestHeader,
  TestResultRecord,
} from '../../domain/trace-event-recorder/model/statement-trace-schema';

export interface TraceModel {
  header: TestHeader;
  statements: Statement[];
  result?: TestResultRecord;
  /**
   * Files Playwright produced for the test (`trace.zip`, video,
   * failure screenshots, user attachments). Empty when the optional
   * `HealTracerReporter` is not registered — its absence is not an
   * error.
   */
  attachments: TestAttachment[];
}

interface RawHeaderRecord {
  kind: 'test-header';
  test: TestHeader;
}
interface RawStatementRecord {
  kind: 'statement';
  statement: Statement;
}

type AnyRecord =
  | RawHeaderRecord
  | RawStatementRecord
  | TestResultRecord
  | TestAttachmentsRecord
  | { kind: string };

const parseLine = (line: string, lineNumber: number): AnyRecord | null => {
  try {
    return JSON.parse(line) as AnyRecord;
  } catch (err) {
    console.warn(`[heal-tracer] malformed JSON at line ${String(lineNumber)}:`, err);

    return null;
  }
};

export const loadTrace = async (ndjsonPath: string): Promise<TraceModel> => {
  const content = await readFile(ndjsonPath, 'utf-8');
  const lines = content.split('\n');

  let header: TestHeader | null = null;
  const statements: Statement[] = [];
  let result: TestResultRecord | undefined;
  let attachments: TestAttachment[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      continue;
    }
    const record = parseLine(trimmed, i + 1);
    if (!record) {
      continue;
    }
    switch (record.kind) {
      case 'test-header':
        header = (record as RawHeaderRecord).test;
        break;
      case 'statement':
        statements.push((record as RawStatementRecord).statement);
        break;
      case 'test-result':
        result = record as TestResultRecord;
        break;
      case 'test-attachments':
        attachments = (record as TestAttachmentsRecord).attachments;
        break;
      default:
        // Forward-compatible: unknown kinds are dropped silently.
        break;
    }
  }

  if (!header) {
    throw new Error(`No test-header record found in ${ndjsonPath}`);
  }

  return { header, statements, attachments, ...(result ? { result } : {}) };
};

/**
 * Rewrite each statement's `screenshot` from a bare filename
 * (`stmt-0007.png`) to a server-relative URL the SPA can fetch.
 * Walks the statement tree depth-first; pure (does not mutate input).
 */
export const rewriteScreenshots = (
  statements: Statement[],
  toUrl: (filename: string) => string,
): Statement[] =>
  statements.map((stmt) => ({
    ...stmt,
    screenshot: stmt.screenshot ? toUrl(stmt.screenshot) : undefined,
    children: rewriteScreenshots(stmt.children, toUrl),
  }));
