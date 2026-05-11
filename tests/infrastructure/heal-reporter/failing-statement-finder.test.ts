/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { FailingStatementFinder } from '../../../src/infrastructure/heal-reporter/failing-statement-finder';

const finder = new FailingStatementFinder();

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-failing-stmt-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeNdjson(lines: unknown[]): string {
  const p = path.join(tmpDir, 'heal-traces.ndjson');
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return p;
}

function leafStmt(over: Record<string, unknown> = {}) {
  return {
    seq: 1,
    index: 0,
    file: 'x.spec.ts',
    line: 1,
    endLine: 1,
    kind: 'ExpressionStatement',
    scope: 'root',
    source: 'noop()',
    hasAwait: false,
    step: null,
    stepPath: null,
    status: 'ok',
    duration: 1,
    t: 0,
    children: [],
    ...over,
  };
}

describe('FailingStatementFinder', () => {
  it('returns null when the file is missing', () => {
    expect(finder.find(path.join(tmpDir, 'nope.ndjson'))).toBeNull();
  });

  it('returns null for a fully-passed test', () => {
    const p = writeNdjson([
      { kind: 'test-header', test: {} },
      { kind: 'statement', statement: leafStmt({ status: 'ok' }) },
      { kind: 'test-result', status: 'passed', duration: 1 },
    ]);
    expect(finder.find(p)).toBeNull();
  });

  it('returns the threw leaf with its error', () => {
    const p = writeNdjson([
      { kind: 'test-header', test: {} },
      {
        kind: 'statement',
        statement: leafStmt({
          index: 7,
          status: 'threw',
          source: 'await page.click()',
          error: { message: 'boom' },
        }),
      },
      { kind: 'test-result', status: 'failed', duration: 1 },
    ]);
    const found = finder.find(p);
    expect(found?.statement.index).toBe(7);
    expect(found?.statement.source).toBe('await page.click()');
    expect(found?.error.message).toBe('boom');
  });

  it('picks the DEEPEST threw node when multiple ancestors also threw', () => {
    const p = writeNdjson([
      { kind: 'test-header', test: {} },
      {
        kind: 'statement',
        statement: leafStmt({
          index: 0,
          status: 'threw',
          source: 'await user.step()',
          error: { message: 'outer' },
          children: [
            leafStmt({
              index: 1,
              status: 'threw',
              source: 'page.locator().click()',
              error: { message: 'inner-locator', isPlaywrightError: true },
            }),
          ],
        }),
      },
    ]);
    const found = finder.find(p);
    expect(found?.statement.index).toBe(1);
    expect(found?.error.message).toBe('inner-locator');
    expect(found?.error.isPlaywrightError).toBe(true);
  });

  it('tolerates a torn last line', () => {
    const p = path.join(tmpDir, 'heal-traces.ndjson');
    fs.writeFileSync(
      p,
      JSON.stringify({
        kind: 'statement',
        statement: leafStmt({
          index: 3,
          status: 'threw',
          error: { message: 'real' },
        }),
      }) +
        '\n' +
        '{"kind":"test-resu', // truncated
      'utf8',
    );
    const found = finder.find(p);
    expect(found?.statement.index).toBe(3);
    expect(found?.error.message).toBe('real');
  });

  it('returns null when threw statement has no error attached (defensive)', () => {
    const p = writeNdjson([{ kind: 'statement', statement: leafStmt({ status: 'threw' }) }]);
    expect(finder.find(p)).toBeNull();
  });

  it('returns null on an empty/whitespace-only file', () => {
    const p = path.join(tmpDir, 'heal-traces.ndjson');
    fs.writeFileSync(p, '\n\n   \n', 'utf8');
    expect(finder.find(p)).toBeNull();
  });

  it('picks the deepest threw across multiple root statement records', () => {
    const p = writeNdjson([
      {
        kind: 'statement',
        statement: leafStmt({
          index: 0,
          status: 'ok',
          children: [
            leafStmt({
              index: 1,
              status: 'threw',
              source: 'shallow-threw',
              error: { message: 'shallow' },
            }),
          ],
        }),
      },
      {
        kind: 'statement',
        statement: leafStmt({
          index: 2,
          status: 'threw',
          source: 'deeper-root',
          error: { message: 'mid' },
          children: [
            leafStmt({
              index: 3,
              status: 'threw',
              source: 'mid-deep',
              error: { message: 'mid-deep' },
              children: [
                leafStmt({
                  index: 4,
                  status: 'threw',
                  source: 'deepest',
                  error: { message: 'deepest' },
                }),
              ],
            }),
          ],
        }),
      },
    ]);
    const found = finder.find(p);
    expect(found?.statement.source).toBe('deepest');
    expect(found?.error.message).toBe('deepest');
  });

  it('ignores non-statement records (test-header, test-result, test-attachments)', () => {
    const p = writeNdjson([
      { kind: 'test-header', test: {} },
      { kind: 'test-result', status: 'failed', duration: 1, error: { message: 'header-error' } },
      { kind: 'test-attachments', attachments: [] },
    ]);
    expect(finder.find(p)).toBeNull();
  });
});
