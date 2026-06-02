/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  loadTrace,
  rewriteScreenshots,
} from '../../../src/infrastructure/local-viewer-adapter/ndjson-trace-loader';

const HEADER = {
  kind: 'test-header',
  schemaVersion: 1,
  test: {
    title: 't',
    titlePath: ['t'],
    file: 'a.spec.ts',
    project: 'chromium',
    workerIndex: 0,
    retry: 0,
    startedAt: 1,
    env: {},
    context: { testId: 't', attempt: 1 },
  },
};
const STMT = (seq: number, screenshot?: string) => ({
  kind: 'statement',
  statement: {
    seq,
    file: 'a.spec.ts',
    line: seq,
    endLine: seq,
    kind: 'ExpressionStatement',
    scope: 'test',
    source: `stmt ${String(seq)}`,
    hasAwait: false,
    step: null,
    stepPath: null,
    status: 'ok',
    duration: 5,
    t: seq * 5,
    children: [] as unknown[],
    ...(screenshot ? { screenshot } : {}),
  },
});

const RESULT = { kind: 'test-result', status: 'passed', duration: 100 };

const writeNdjson = async (lines: object[]): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'heal-tracer-load-'));
  const file = path.join(dir, 'heal-traces.ndjson');
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf-8');

  return file;
};

describe('loadTrace', () => {
  it('parses header, statements (in order), and result', async () => {
    const file = await writeNdjson([HEADER, STMT(1), STMT(2), RESULT]);
    const trace = await loadTrace(file);
    expect(trace.header.title).toBe('t');
    expect(trace.statements.map((s) => s.seq)).toEqual([1, 2]);
    expect(trace.result?.status).toBe('passed');
  });

  it('returns no result when terminator is missing (partial trace)', async () => {
    const file = await writeNdjson([HEADER, STMT(1)]);
    const trace = await loadTrace(file);
    expect(trace.result).toBeUndefined();
    expect(trace.statements).toHaveLength(1);
  });

  it('throws when header is missing', async () => {
    const file = await writeNdjson([STMT(1), RESULT]);
    await expect(loadTrace(file)).rejects.toThrow(/test-header/);
  });

  it('drops malformed JSON lines without throwing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'heal-tracer-load-'));
    const file = path.join(dir, 'heal-traces.ndjson');
    const content =
      JSON.stringify(HEADER) +
      '\nnot-json-here\n' +
      JSON.stringify(STMT(1)) +
      '\n' +
      JSON.stringify(RESULT);
    await writeFile(file, content, 'utf-8');
    const trace = await loadTrace(file);
    expect(trace.statements).toHaveLength(1);
    expect(trace.result?.status).toBe('passed');
  });

  it('drops unknown record kinds silently (forward-compat)', async () => {
    const file = await writeNdjson([
      HEADER,
      { kind: 'future-record-type', payload: 42 },
      STMT(1),
      RESULT,
    ]);
    const trace = await loadTrace(file);
    expect(trace.statements).toHaveLength(1);
  });

  it('derives trace.source from statement files, spec file first and flagged entry', async () => {
    // HEADER.file is relative and env.cwd is unset, so it is the entry
    // path verbatim. A nested child runs in a helper file.
    const withChild = {
      kind: 'statement',
      statement: {
        ...STMT(1).statement,
        file: 'a.spec.ts',
        children: [{ ...STMT(2).statement, file: 'pages/login.ts', children: [] }],
      },
    };
    const file = await writeNdjson([HEADER, withChild, RESULT]);
    const trace = await loadTrace(file);
    expect(trace.source).toEqual([{ path: 'a.spec.ts', entry: true }, { path: 'pages/login.ts' }]);
  });

  it('relativizes an absolute spec file against env.cwd to flag the entry', async () => {
    const header = {
      ...HEADER,
      test: { ...HEADER.test, file: '/repo/tests/a.spec.ts', env: { cwd: '/repo' } },
    };
    const stmt = {
      kind: 'statement',
      statement: { ...STMT(1).statement, file: 'tests/a.spec.ts' },
    };
    const file = await writeNdjson([header, stmt, RESULT]);
    const trace = await loadTrace(file);
    expect(trace.source).toEqual([{ path: 'tests/a.spec.ts', entry: true }]);
  });

  it('lists the spec file first even when no statement references it', async () => {
    const stmt = { kind: 'statement', statement: { ...STMT(1).statement, file: 'pages/login.ts' } };
    const file = await writeNdjson([HEADER, stmt, RESULT]);
    const trace = await loadTrace(file);
    expect(trace.source).toEqual([{ path: 'a.spec.ts', entry: true }, { path: 'pages/login.ts' }]);
  });
});

describe('rewriteScreenshots', () => {
  it('rewrites bare filenames to URLs and recurses into children', () => {
    const stmts = [
      {
        ...STMT(1, 'stmt-0001.png').statement,
        children: [STMT(2, 'stmt-0002.png').statement, STMT(3).statement],
      },
    ];
    const out = rewriteScreenshots(stmts as never[], (f) => `/api/screenshot/test-1/${f}`);
    expect(out[0].screenshot).toBe('/api/screenshot/test-1/stmt-0001.png');
    expect(out[0].children[0].screenshot).toBe('/api/screenshot/test-1/stmt-0002.png');
    expect(out[0].children[1].screenshot).toBeUndefined();
  });

  it('does not mutate the input array', () => {
    const stmt = STMT(1, 'a.png').statement;
    const stmts = [stmt];
    rewriteScreenshots(stmts as never[], (f) => `URL/${f}`);
    expect(stmt.screenshot).toBe('a.png');
  });
});
