/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LocationBasedFailureFinder } from '../../../src/infrastructure/heal-reporter/location-based-failure-finder';

const finder = new LocationBasedFailureFinder();

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-loc-finder-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeNdjson(lines: unknown[]): string {
  const p = path.join(tmpDir, 'heal-traces.ndjson');
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return p;
}

function stmt(over: Record<string, unknown> = {}) {
  return {
    seq: 1,
    index: 0,
    file: 'specs/checkout.spec.ts',
    line: 10,
    endLine: 10,
    kind: 'ExpressionStatement',
    scope: 'test: t',
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

const FILE = 'specs/checkout.spec.ts';

describe('LocationBasedFailureFinder', () => {
  it('returns null when no error carries a location (caller falls back to the heuristic)', () => {
    const p = writeNdjson([{ kind: 'statement', statement: stmt({ status: 'threw' }) }]);
    expect(finder.find([{ message: 'boom' }], p)).toBeNull();
    expect(finder.find([], p)).toBeNull();
  });

  it('maps a location onto the recorded statement at that line', () => {
    const p = writeNdjson([
      {
        kind: 'statement',
        statement: stmt({
          index: 3,
          line: 42,
          endLine: 42,
          status: 'threw',
          source: 'await expect(x).toBe(y)',
          error: { message: 'fail' },
        }),
      },
    ]);
    const found = finder.find(
      [{ message: 'fail', location: { file: `/abs/${FILE}`, line: 42 } }],
      p,
    );
    expect(found?.statement.index).toBe(3);
    expect(found?.statement.line).toBe(42);
    expect(found?.error.message).toBe('fail');
  });

  it('locates a body failure buried under `ok` fixture use() wrappers (no scope inference)', () => {
    // The bug shape: every wrapper is `ok`; the real throw is a deep
    // descendant. Location maps straight to it regardless of nesting.
    const p = writeNdjson([
      {
        kind: 'statement',
        statement: stmt({
          index: 0,
          line: 1,
          endLine: 1,
          status: 'ok',
          scope: '<anonymous>',
          source: 'await use(page)',
          children: [
            stmt({
              index: 1,
              line: 2,
              endLine: 2,
              status: 'ok',
              scope: '<anonymous>',
              source: 'await use(ctx)',
              children: [
                stmt({
                  index: 2,
                  line: 91,
                  endLine: 91,
                  status: 'ok',
                  scope: 'test: t',
                  source: 'goto',
                }),
                stmt({
                  index: 3,
                  line: 92,
                  endLine: 92,
                  status: 'threw',
                  scope: 'test: t',
                  source: 'await expect(...).toBeVisible()',
                  error: { message: 'not visible', isPlaywrightError: true },
                }),
              ],
            }),
          ],
        }),
      },
    ]);
    const found = finder.find(
      [{ message: 'not visible', location: { file: `/repo/${FILE}`, line: 92 } }],
      p,
    );
    expect(found?.statement.index).toBe(3);
    expect(found?.statement.scope).toBe('test: t');
    expect(found?.error.isPlaywrightError).toBe(true);
  });

  it('ignores a source-caught throw: Playwright points at the real failure, so we land there', () => {
    // A caught throw was recorded as `threw` at line 5, but it is NOT in
    // result.errors (Playwright only reports the uncaught one at line 9).
    const p = writeNdjson([
      {
        kind: 'statement',
        statement: stmt({
          index: 0,
          line: 5,
          endLine: 5,
          status: 'threw',
          source: 'await probe() // caught',
          error: { message: 'swallowed' },
        }),
      },
      {
        kind: 'statement',
        statement: stmt({
          index: 1,
          line: 9,
          endLine: 9,
          status: 'threw',
          source: 'await expect(a).toBe(b)',
          error: { message: 'real failure' },
        }),
      },
    ]);
    const found = finder.find(
      [{ message: 'real failure', location: { file: `/repo/${FILE}`, line: 9 } }],
      p,
    );
    expect(found?.statement.index).toBe(1);
    expect(found?.error.message).toBe('real failure');
  });

  it('prefers a `threw` statement over an `ok` one at the same line', () => {
    const p = writeNdjson([
      {
        kind: 'statement',
        statement: stmt({
          index: 0,
          line: 20,
          endLine: 20,
          status: 'ok',
          source: 'await wrapper()',
          children: [
            stmt({
              index: 1,
              line: 20,
              endLine: 20,
              status: 'threw',
              source: 'inner',
              error: { message: 'm' },
            }),
          ],
        }),
      },
    ]);
    const found = finder.find([{ location: { file: `/repo/${FILE}`, line: 20 } }], p);
    expect(found?.statement.index).toBe(1);
  });

  it('returns null when the location maps to no recorded statement (un-instrumented file/line)', () => {
    const p = writeNdjson([
      {
        kind: 'statement',
        statement: stmt({ line: 10, endLine: 10, status: 'threw', error: { message: 'm' } }),
      },
    ]);
    // wrong file
    expect(finder.find([{ location: { file: '/repo/other.spec.ts', line: 10 } }], p)).toBeNull();
    // line out of any range
    expect(finder.find([{ location: { file: `/repo/${FILE}`, line: 999 } }], p)).toBeNull();
  });

  it('synthesizes an error from the Playwright error when the matched statement has none', () => {
    const p = writeNdjson([
      {
        kind: 'statement',
        statement: stmt({ index: 4, line: 30, endLine: 30, status: 'threw', source: 'x' }),
      }, // no error on the statement
    ]);
    const found = finder.find(
      [
        {
          message: 'from playwright',
          stack: 'at thing:1:1',
          location: { file: `/repo/${FILE}`, line: 30 },
        },
      ],
      p,
    );
    expect(found?.statement.index).toBe(4);
    expect(found?.error.message).toBe('from playwright');
    expect(found?.error.isPlaywrightError).toBe(true);
  });

  it('skips errors without a location and uses the first locatable one', () => {
    const p = writeNdjson([
      {
        kind: 'statement',
        statement: stmt({
          index: 2,
          line: 50,
          endLine: 50,
          status: 'threw',
          error: { message: 'second' },
        }),
      },
    ]);
    const found = finder.find(
      [
        { message: 'no-location-error' },
        { message: 'second', location: { file: `/repo/${FILE}`, line: 50 } },
      ],
      p,
    );
    expect(found?.statement.index).toBe(2);
  });

  it('returns null when the trace file is unreadable', () => {
    expect(
      finder.find(
        [{ location: { file: `/repo/${FILE}`, line: 1 } }],
        path.join(tmpDir, 'nope.ndjson'),
      ),
    ).toBeNull();
  });
});
