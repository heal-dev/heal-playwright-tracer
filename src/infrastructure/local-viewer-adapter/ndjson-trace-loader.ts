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
import * as path from 'node:path';

import type {
  Statement,
  TestAttachment,
  TestAttachmentsRecord,
  TestHeader,
  TestResultRecord,
} from '../../domain/trace-event-recorder/model/statement-trace-schema';

export interface TraceSourceFile {
  /**
   * Source-file path RELATIVE to the repo root (`rootDir`), forward
   * slashes. The content lives in the live working tree at
   * `<rootDir>/<path>` and is streamed by the viewer's source endpoint
   * — the tracer does NOT copy source into the trace dir.
   */
  path: string;
  /** True for the spec file itself (the test header's file). */
  entry?: boolean;
}

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
  /**
   * Distinct in-repo source files referenced by the trace — the spec
   * file plus every file that produced an executed statement. Derived
   * from the statement stream (there is no manifest record); the
   * viewer reads each file's content live from the working tree.
   */
  source: TraceSourceFile[];
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

  const source = deriveSource(header, statements);

  return { header, statements, attachments, source, ...(result ? { result } : {}) };
};

/**
 * Derive the trace's source-file list from the statement stream. Each
 * `statement.file` is already repo-root-relative; the header's spec
 * file is absolute, so we relativize it against the recorded
 * `env.cwd` to flag the entry and list it first. Walks the statement
 * tree (nested calls live in `children`).
 */
const deriveSource = (header: TestHeader, statements: Statement[]): TraceSourceFile[] => {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const visit = (stmt: Statement): void => {
    if (stmt.file && !seen.has(stmt.file)) {
      seen.add(stmt.file);
      ordered.push(stmt.file);
    }
    stmt.children.forEach(visit);
  };
  statements.forEach(visit);

  const entryRel =
    header.env.cwd && path.isAbsolute(header.file)
      ? path.relative(header.env.cwd, header.file).split(path.sep).join('/')
      : header.file;

  // Spec file first (even if it produced no statements), then every
  // other referenced file in first-executed order.
  const files: string[] = [];
  if (entryRel) files.push(entryRel);
  for (const f of ordered) {
    if (f !== entryRel) files.push(f);
  }

  return files.map((p) => (p === entryRel ? { path: p, entry: true } : { path: p }));
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

/**
 * Stamp each statement's `videoTime` (seconds into its page's recorded
 * video) so the SPA can seek the right video to the moment a statement
 * ran. `videoTime = max(0, (startedAtMs + stmt.t − anchor) / 1000)`,
 * where `anchor` is the page's `videoStartWallMs` looked up by
 * `stmt.pageId`. Walks the tree depth-first; pure (does not mutate
 * input). Leaves `videoTime` unset when the statement has no `pageId`,
 * its page recorded no video, or the test start is unknown — exactly
 * the cases where no offset is meaningful.
 */
export const stampVideoTimes = (
  statements: Statement[],
  startedAtMs: number | undefined,
  videoStartByPageId: Map<string, number>,
): Statement[] =>
  statements.map((stmt) => {
    const anchor = stmt.pageId !== undefined ? videoStartByPageId.get(stmt.pageId) : undefined;
    const videoTime =
      startedAtMs !== undefined && anchor !== undefined
        ? Math.max(0, (startedAtMs + stmt.t - anchor) / 1000)
        : undefined;
    return {
      ...stmt,
      ...(videoTime !== undefined ? { videoTime } : {}),
      children: stampVideoTimes(stmt.children, startedAtMs, videoStartByPageId),
    };
  });
