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

  it('skips a CAUGHT threw (parent returned ok despite child threw) and picks the next uncaught one', () => {
    // Mirrors a real production trace shape:
    //   - root #1: closeModalIfExists wraps a `waitFor()` in try/catch
    //     → root returns ok, but the child waitFor `threw`. This must
    //       be ignored — the catch swallowed it.
    //   - root #2: addBankAccount threw because an inner `expect()`
    //     threw and propagated. Both the root and the inner expect are
    //     `threw` → uncaught chain → pick the deeper one.
    //   - root #3: same as root #1 (afterEach helper) → also caught.
    const p = writeNdjson([
      { kind: 'test-header', test: {} },
      {
        kind: 'statement',
        statement: leafStmt({
          index: 0,
          status: 'ok',
          scope: 'test: t',
          source: 'closeModalIfExists()',
          children: [
            leafStmt({
              index: 1,
              status: 'threw',
              scope: 'closeModalIfExists',
              source: 'await waitFor({ timeout: 15_000 })',
              error: { message: 'locator.waitFor: Timeout exceeded' },
            }),
            leafStmt({
              index: 2,
              status: 'ok',
              scope: 'closeModalIfExists',
              source: "console.log('No modal')",
            }),
          ],
        }),
      },
      {
        kind: 'statement',
        statement: leafStmt({
          index: 3,
          status: 'threw',
          scope: 'test: t',
          source: 'await addBankAccount()',
          error: { message: 'expect(...).toBeVisible() failed' },
          children: [
            leafStmt({
              index: 4,
              status: 'threw',
              scope: 'addBankAccount',
              source: 'await expect(...heading).toBeVisible()',
              error: { message: 'expect(...).toBeVisible() failed', isPlaywrightError: true },
            }),
          ],
        }),
      },
      {
        kind: 'statement',
        statement: leafStmt({
          index: 5,
          status: 'ok',
          scope: 'afterEach: cleanup',
          source: 'closeModalIfExists() // afterEach',
          children: [
            leafStmt({
              index: 6,
              status: 'threw',
              scope: 'closeModalIfExists',
              source: 'await waitFor({ timeout: 15_000 })',
              error: { message: 'locator.waitFor: Timeout exceeded' },
            }),
          ],
        }),
      },
      { kind: 'test-result', status: 'failed', duration: 1 },
    ]);
    const found = finder.find(p);
    expect(found?.statement.index).toBe(4);
    expect(found?.statement.source).toBe('await expect(...heading).toBeVisible()');
    expect(found?.error.isPlaywrightError).toBe(true);
  });

  it('try/catch at top level: child threw inside a parent that returned ok → caught', () => {
    // Models the textbook pattern:
    //   try { await page.click('nope'); } catch {}  // (in test body)
    // The wrapping try/catch is a root that returned `ok`; the click
    // inside it threw and was swallowed → no failing statement.
    const p = writeNdjson([
      {
        kind: 'statement',
        statement: leafStmt({
          index: 0,
          status: 'ok',
          source: 'try { … } catch { /* swallow */ }',
          children: [
            leafStmt({
              index: 1,
              status: 'threw',
              source: "await page.click('nope')",
              error: { message: 'click timeout', isPlaywrightError: true },
            }),
          ],
        }),
      },
    ]);
    expect(finder.find(p)).toBeNull();
  });

  it('try/catch INSIDE a helper function: helper returns ok, inner throw is caught', () => {
    // Helper `closeModalIfExists()` internally does:
    //   try { await locator.waitFor({ timeout: 15s }); } catch { return false; }
    // The helper as a root statement returns `ok`. Anything that
    // threw inside it was caught by the helper itself → caught.
    const p = writeNdjson([
      {
        kind: 'statement',
        statement: leafStmt({
          index: 0,
          status: 'ok',
          source: 'await closeModalIfExists(page)',
          children: [
            leafStmt({
              index: 1,
              status: 'ok',
              source: 'const btn = page.locator(\'button:has-text("Close")\')',
            }),
            leafStmt({
              index: 2,
              status: 'threw',
              source: 'await btn.first().waitFor({ timeout: 15_000 })',
              error: { message: 'locator.waitFor: Timeout 15000ms exceeded' },
            }),
            leafStmt({
              index: 3,
              status: 'ok',
              source: "console.log('No first modal appeared within 15s')",
            }),
          ],
        }),
      },
    ]);
    expect(finder.find(p)).toBeNull();
  });

  it('failure inside a function that propagates (1 nesting level): pick the leaf', () => {
    // `await assertVisible()` is a root threw whose body's inner
    // `expect().toBeVisible()` threw and propagated up. Both nodes
    // are `threw`; we report the inner one (the actual location).
    const p = writeNdjson([
      {
        kind: 'statement',
        statement: leafStmt({
          index: 0,
          status: 'threw',
          source: "await assertVisible('Heading')",
          error: { message: 'expect.toBeVisible failed' },
          children: [
            leafStmt({
              index: 1,
              status: 'threw',
              source: "await expect(page.getByRole('heading')).toBeVisible()",
              error: { message: 'expect.toBeVisible failed', isPlaywrightError: true },
            }),
          ],
        }),
      },
    ]);
    const found = finder.find(p);
    expect(found?.statement.index).toBe(1);
    expect(found?.statement.source).toBe("await expect(page.getByRole('heading')).toBeVisible()");
  });

  it('2 nesting levels: function1 → function2 → leaf that fails, all propagate → pick the leaf', () => {
    // test body
    //   └─ await flow1()                    (function1, threw)
    //         └─ await flow2()              (function2, threw)
    //               └─ await leaf.click()   (leaf, threw)  ← expected
    const p = writeNdjson([
      {
        kind: 'statement',
        statement: leafStmt({
          index: 0,
          status: 'threw',
          source: 'await flow1()',
          error: { message: 'click timeout' },
          children: [
            leafStmt({
              index: 1,
              status: 'threw',
              source: 'await flow2()',
              error: { message: 'click timeout' },
              children: [
                leafStmt({
                  index: 2,
                  status: 'threw',
                  source: "await page.getByRole('button', { name: 'Next' }).click()",
                  error: { message: 'click timeout', isPlaywrightError: true },
                }),
              ],
            }),
          ],
        }),
      },
    ]);
    const found = finder.find(p);
    expect(found?.statement.index).toBe(2);
    expect(found?.statement.source).toBe(
      "await page.getByRole('button', { name: 'Next' }).click()",
    );
    expect(found?.error.isPlaywrightError).toBe(true);
  });

  it('body throws AND afterEach throws: pick the body throw (first crashing scope wins)', () => {
    // Even when afterEach's uncaught throw is at deeper depth than the
    // body's, the body scope wins because Playwright runs afterEach
    // AFTER the body fails — the afterEach throw is collateral on a
    // broken UI state, not the test's actual cause. Scope-grouping
    // makes this fall out: the body scope's last root is `threw`, so
    // we stop there and never look at the afterEach group.
    const p = writeNdjson([
      // --- test body scope: one root, threw at depth 0 ---
      {
        kind: 'statement',
        statement: leafStmt({
          index: 10,
          status: 'threw',
          scope: 'test: the test',
          source: "await expect(page.getByText('OK')).toBeVisible()",
          error: { message: 'body assertion failed', isPlaywrightError: true },
        }),
      },
      // --- afterEach scope: DEEPER uncaught chain ---
      {
        kind: 'statement',
        statement: leafStmt({
          index: 20,
          status: 'threw',
          scope: 'afterEach: cleanup',
          source: 'await cleanup()',
          error: { message: 'cleanup blew up' },
          children: [
            leafStmt({
              index: 21,
              status: 'threw',
              scope: 'cleanup',
              source: 'await deleteAll()',
              error: { message: 'cleanup blew up' },
              children: [
                leafStmt({
                  index: 22,
                  status: 'threw',
                  scope: 'deleteAll',
                  source: "await page.getByRole('button', { name: 'Delete' }).click()",
                  error: { message: 'cleanup blew up' },
                }),
              ],
            }),
          ],
        }),
      },
    ]);
    const found = finder.find(p);
    expect(found?.statement.index).toBe(10);
    expect(found?.error.message).toBe('body assertion failed');
  });

  it('body has only caught throws, afterEach has an uncaught throw → pick the afterEach one', () => {
    // Body scope didn't crash (the only body root returned `ok`); the
    // adapter falls through to the afterEach scope, which crashed.
    const p = writeNdjson([
      {
        kind: 'statement',
        statement: leafStmt({
          index: 0,
          status: 'ok',
          scope: 'test: t',
          source: 'await closeModalIfExists()',
          children: [
            leafStmt({
              index: 1,
              status: 'threw',
              scope: 'closeModalIfExists',
              source: 'await waitFor()',
              error: { message: 'caught by helper' },
            }),
          ],
        }),
      },
      {
        kind: 'statement',
        statement: leafStmt({
          index: 2,
          status: 'threw',
          scope: 'afterEach: cleanup',
          source: 'await cleanup()',
          error: { message: 'afterEach failed for real', isPlaywrightError: true },
        }),
      },
    ]);
    const found = finder.find(p);
    expect(found?.statement.index).toBe(2);
    expect(found?.error.message).toBe('afterEach failed for real');
  });

  it('source-level try/catch at root scope: subsequent `ok` root in same scope marks the throw as caught', () => {
    // Real Pennylane-style pattern:
    //   try { await probe1(); } catch {}   // root, threw (caught at source)
    //   try { await probe2(); } catch {}   // root, threw (caught at source)
    //   await realWork();                  // root, ok
    // The tracer can't see the source-level catches, but the fact that
    // a subsequent `ok` root exists in the same scope is the signal:
    // execution continued past the throws, so they were caught.
    const p = writeNdjson([
      {
        kind: 'statement',
        statement: leafStmt({
          index: 0,
          status: 'threw',
          scope: 'test: t',
          source: "await page.getByText('nudge').click()",
          error: { message: 'click timeout', isPlaywrightError: true },
        }),
      },
      {
        kind: 'statement',
        statement: leafStmt({
          index: 1,
          status: 'threw',
          scope: 'test: t',
          source: "await page.getByText('banner').click()",
          error: { message: 'click timeout', isPlaywrightError: true },
        }),
      },
      {
        kind: 'statement',
        statement: leafStmt({
          index: 2,
          status: 'ok',
          scope: 'test: t',
          source: "await page.goto('/')",
        }),
      },
    ]);
    expect(finder.find(p)).toBeNull();
  });

  it('source-level try/catch then real failure: pick the last `threw` in the test scope', () => {
    // Pennylane test-body pattern with a real failure at the end.
    const p = writeNdjson([
      {
        kind: 'statement',
        statement: leafStmt({
          index: 0,
          status: 'threw',
          scope: 'test: t',
          source: "await page.getByText('probe').click()",
          error: { message: 'caught probe' },
        }),
      },
      {
        kind: 'statement',
        statement: leafStmt({
          index: 1,
          status: 'ok',
          scope: 'test: t',
          source: "await page.getByText('login').fill('x')",
        }),
      },
      {
        kind: 'statement',
        statement: leafStmt({
          index: 2,
          status: 'threw',
          scope: 'test: t',
          source: "await page.getByRole('button', { name: 'Submit' }).click()",
          error: { message: 'click timeout', isPlaywrightError: true },
        }),
      },
    ]);
    const found = finder.find(p);
    expect(found?.statement.index).toBe(2);
    expect(found?.statement.source).toBe(
      "await page.getByRole('button', { name: 'Submit' }).click()",
    );
  });

  it('beforeEach with source try/catch then real failure: pick the last `threw` in beforeEach scope', () => {
    // Same shape as the test-body case but inside `beforeEach`. The
    // test body is skipped (never recorded — tracer only emits
    // completed statements), so the beforeEach group is the FIRST
    // crashing group and wins.
    const p = writeNdjson([
      {
        kind: 'statement',
        statement: leafStmt({
          index: 0,
          status: 'threw',
          scope: 'beforeEach: setup',
          source: "try { await page.getByText('cookie banner').click() } catch {}",
          error: { message: 'caught probe in setup' },
        }),
      },
      {
        kind: 'statement',
        statement: leafStmt({
          index: 1,
          status: 'ok',
          scope: 'beforeEach: setup',
          source: "await page.goto('/login')",
        }),
      },
      {
        kind: 'statement',
        statement: leafStmt({
          index: 2,
          status: 'threw',
          scope: 'beforeEach: setup',
          source: "await page.getByRole('button', { name: 'Log in' }).click()",
          error: { message: 'login button missing', isPlaywrightError: true },
        }),
      },
      // afterEach still runs after a beforeEach crash; it should be
      // ignored because the beforeEach group already crashed.
      {
        kind: 'statement',
        statement: leafStmt({
          index: 3,
          status: 'threw',
          scope: 'afterEach: cleanup',
          source: 'await cleanup()',
          error: { message: 'cleanup also blew up' },
        }),
      },
    ]);
    const found = finder.find(p);
    expect(found?.statement.index).toBe(2);
    expect(found?.statement.scope).toBe('beforeEach: setup');
  });

  it('beforeEach throws uncaught AND afterEach throws uncaught: pick the beforeEach throw', () => {
    // First crashing scope (in lifecycle / file order) wins. beforeEach
    // runs before afterEach, so its group is encountered first.
    const p = writeNdjson([
      {
        kind: 'statement',
        statement: leafStmt({
          index: 0,
          status: 'threw',
          scope: 'beforeEach: setup',
          source: 'await ensureLoggedIn()',
          error: { message: 'setup failed', isPlaywrightError: true },
        }),
      },
      // No test-body roots: the body never ran because beforeEach crashed.
      {
        kind: 'statement',
        statement: leafStmt({
          index: 1,
          status: 'threw',
          scope: 'afterEach: cleanup',
          source: 'await cleanup()',
          error: { message: 'cleanup also blew up' },
        }),
      },
    ]);
    const found = finder.find(p);
    expect(found?.statement.index).toBe(0);
    expect(found?.statement.scope).toBe('beforeEach: setup');
    expect(found?.error.message).toBe('setup failed');
  });

  it('test body has no throws (all ok), afterEach throws uncaught: pick the afterEach throw', () => {
    // Body scope group ends in `ok` (no throws at all). Algorithm
    // falls through to the next scope group — afterEach — and picks
    // its uncaught throw.
    const p = writeNdjson([
      {
        kind: 'statement',
        statement: leafStmt({
          index: 0,
          status: 'ok',
          scope: 'test: t',
          source: "await page.goto('/')",
        }),
      },
      {
        kind: 'statement',
        statement: leafStmt({
          index: 1,
          status: 'ok',
          scope: 'test: t',
          source: "await expect(page.getByText('Welcome')).toBeVisible()",
        }),
      },
      {
        kind: 'statement',
        statement: leafStmt({
          index: 2,
          status: 'threw',
          scope: 'afterEach: cleanup',
          source: 'await resetDatabase()',
          error: { message: 'DB reset failed', isPlaywrightError: true },
        }),
      },
    ]);
    const found = finder.find(p);
    expect(found?.statement.index).toBe(2);
    expect(found?.statement.scope).toBe('afterEach: cleanup');
    expect(found?.error.message).toBe('DB reset failed');
  });

  it('test body nested under an `ok` fixture `use()` wrapper: descends to the body crash', () => {
    // Real production shape (heal-stories `admins can delete secrets`):
    // the test body runs inside an auth fixture's `await use(...)`, so
    // the tracer records the whole body as DESCENDANTS of that `use()`
    // call. `use()` resolves `ok` (Playwright catches the body throw at
    // the fixture boundary), so NO root scope-group ends in `threw` and
    // the primary scan finds nothing. The fallback must descend through
    // the `ok` wrapper to the nested `test:` scope and find the crash.
    const p = writeNdjson([
      { kind: 'test-header', test: {} },
      {
        kind: 'statement',
        statement: leafStmt({
          index: 0,
          status: 'ok',
          scope: '<anonymous>',
          source: "await use(await authenticate(browser, 'admin'))",
          children: [
            leafStmt({ index: 1, status: 'ok', scope: 'authenticate', source: 'await login()' }),
            leafStmt({
              index: 2,
              status: 'ok',
              scope: 'test: admins can delete secrets',
              source: "await page.goto('/secrets')",
            }),
            leafStmt({
              index: 3,
              status: 'threw',
              scope: 'test: admins can delete secrets',
              source: "await expect(page.getByText('No secrets yet.')).toBeVisible()",
              error: { message: 'element(s) not found', isPlaywrightError: true },
            }),
          ],
        }),
      },
      { kind: 'test-result', status: 'failed', duration: 1 },
    ]);
    const found = finder.find(p);
    expect(found?.statement.index).toBe(3);
    expect(found?.statement.scope).toBe('test: admins can delete secrets');
    expect(found?.error.isPlaywrightError).toBe(true);
  });

  it('test body nested under a CHAIN of `ok` use() wrappers: still descends to the crash', () => {
    // Mirrors the exact failing trace: use(authenticate) → withRecorded
    // Context → use(ctx) → use(newPage()), all `ok`, with the test body
    // (and its throw) at the bottom of the chain.
    const p = writeNdjson([
      {
        kind: 'statement',
        statement: leafStmt({
          index: 0,
          status: 'ok',
          scope: '<anonymous>',
          source: 'await use(await authenticate())',
          children: [
            leafStmt({
              index: 1,
              status: 'ok',
              scope: '<anonymous>',
              source: 'await withRecordedContext()',
              children: [
                leafStmt({
                  index: 2,
                  status: 'ok',
                  scope: 'withRecordedContext',
                  source: 'await use(ctx)',
                  children: [
                    leafStmt({
                      index: 3,
                      status: 'ok',
                      scope: '<anonymous>',
                      source: 'await use(await adminContext.newPage())',
                      children: [
                        leafStmt({
                          index: 4,
                          status: 'ok',
                          scope: 'test: admins can delete secrets',
                          source: "await page.goto('/secrets')",
                        }),
                        leafStmt({
                          index: 5,
                          status: 'threw',
                          scope: 'test: admins can delete secrets',
                          source: "await expect(page.getByText('No secrets yet.')).toBeVisible()",
                          error: { message: 'element(s) not found' },
                        }),
                      ],
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      },
    ]);
    const found = finder.find(p);
    expect(found?.statement.index).toBe(5);
    expect(found?.error.message).toBe('element(s) not found');
  });

  it('failure inside a propagating helper nested under an `ok` use() wrapper: picks the leaf', () => {
    // The body crash is in a helper that propagates: the `test:` call
    // threw, the helper internals threw too. Fallback finds the `test:`
    // group's last (threw), then drills to the deepest uncaught throw.
    const p = writeNdjson([
      {
        kind: 'statement',
        statement: leafStmt({
          index: 0,
          status: 'ok',
          scope: '<anonymous>',
          source: 'await use(page)',
          children: [
            leafStmt({
              index: 1,
              status: 'threw',
              scope: 'test: t',
              source: 'await assertVisible()',
              error: { message: 'not visible' },
              children: [
                leafStmt({
                  index: 2,
                  status: 'threw',
                  scope: 'assertVisible',
                  source: 'await expect(loc).toBeVisible()',
                  error: { message: 'not visible', isPlaywrightError: true },
                }),
              ],
            }),
          ],
        }),
      },
    ]);
    const found = finder.find(p);
    expect(found?.statement.index).toBe(2);
    expect(found?.error.isPlaywrightError).toBe(true);
  });

  it('helper internal try/catch under an `ok` wrapper (NOT a lifecycle scope): stays null', () => {
    // A regular helper called from a fixture: `await closeModal()`
    // resolves `ok`, but inside it a `waitFor()` threw and was caught by
    // the helper (nothing after it in the helper scope). The throw is in
    // a non-lifecycle scope, so the fallback must NOT resurface it.
    const p = writeNdjson([
      {
        kind: 'statement',
        statement: leafStmt({
          index: 0,
          status: 'ok',
          scope: '<anonymous>',
          source: 'await use(page)',
          children: [
            leafStmt({
              index: 1,
              status: 'ok',
              scope: 'fixtureSetup',
              source: 'await closeModalIfExists()',
              children: [
                leafStmt({
                  index: 2,
                  status: 'threw',
                  scope: 'closeModalIfExists',
                  source: 'await btn.waitFor({ timeout: 15_000 })',
                  error: { message: 'caught by helper' },
                }),
              ],
            }),
          ],
        }),
      },
    ]);
    expect(finder.find(p)).toBeNull();
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
