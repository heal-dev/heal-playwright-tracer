/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect } from 'vitest';
import * as t from '@babel/types';
import { parseStatement } from '../../../../helpers/transform';
import { createExpectCallDetector } from '../../../../../src/domain/code-hook-injector/service/statement-analysis/expect-call-detector';

const { matchExpectCall } = createExpectCallDetector(t);

describe('matchExpectCall — what counts as an `await expect(target).…`', () => {
  it('matches a bare `await expect(loc).toBeVisible()`', () => {
    const stmt = parseStatement(`await expect(loc).toBeVisible();`);
    const match = matchExpectCall(stmt);
    expect(match).not.toBeNull();
    expect(t.isIdentifier(match!.target, { name: 'loc' })).toBe(true);
    // `call` is the inner `expect(loc)` CallExpression, not the
    // outer matcher call.
    expect(t.isCallExpression(match!.call)).toBe(true);
    expect(t.isIdentifier(match!.call.callee, { name: 'expect' })).toBe(true);
  });

  it('matches a chain with `.not.`', () => {
    const stmt = parseStatement(`await expect(loc).not.toHaveText("x");`);
    const match = matchExpectCall(stmt);
    expect(match).not.toBeNull();
    expect(t.isIdentifier(match!.target, { name: 'loc' })).toBe(true);
  });

  it('matches `expect.soft(loc)` and finds the soft call', () => {
    const stmt = parseStatement(`await expect.soft(loc).toHaveCount(0);`);
    const match = matchExpectCall(stmt);
    expect(match).not.toBeNull();
    expect(t.isIdentifier(match!.target, { name: 'loc' })).toBe(true);
    expect(t.isMemberExpression(match!.call.callee)).toBe(true);
  });

  it('returns the locator-producing CallExpression as the target (non-Identifier)', () => {
    const stmt = parseStatement(
      `await expect(page.getByRole('heading', { name: 'Secrets' })).toBeVisible();`,
    );
    const match = matchExpectCall(stmt);
    expect(match).not.toBeNull();
    expect(t.isCallExpression(match!.target)).toBe(true);
  });

  it('accepts an optional second arg (Playwright supports `expect(x, "message")`)', () => {
    const stmt = parseStatement(`await expect(loc, "custom message").toBeVisible();`);
    const match = matchExpectCall(stmt);
    expect(match).not.toBeNull();
    expect(t.isIdentifier(match!.target, { name: 'loc' })).toBe(true);
  });

  it('rejects a sync expect (no top-level await)', () => {
    expect(matchExpectCall(parseStatement(`expect(2).toBe(2);`))).toBeNull();
  });

  it('rejects `expect.poll(...)` — the first arg is a callback, never a Locator', () => {
    expect(matchExpectCall(parseStatement(`await expect.poll(() => x).toBe(2);`))).toBeNull();
  });

  it('rejects `expect.anything.weird(...)` — only `expect` and `expect.soft` qualify', () => {
    expect(
      matchExpectCall(parseStatement(`await expect.configure(loc).toBeVisible();`)),
    ).toBeNull();
  });

  it('rejects non-expect await calls', () => {
    expect(matchExpectCall(parseStatement(`await foo();`))).toBeNull();
    expect(matchExpectCall(parseStatement(`await page.click();`))).toBeNull();
  });

  it('rejects non-ExpressionStatement nodes', () => {
    expect(matchExpectCall(parseStatement(`const x = expect(loc);`))).toBeNull();
  });

  it('extracts the outermost matcher name (used for scroll carve-out)', () => {
    expect(matchExpectCall(parseStatement(`await expect(loc).toBeVisible();`))?.matcherName).toBe(
      'toBeVisible',
    );
    expect(
      matchExpectCall(parseStatement(`await expect(loc).toBeInViewport();`))?.matcherName,
    ).toBe('toBeInViewport');
    // `.not.toBeInViewport()` — the OUTERMOST matcher name is still
    // `toBeInViewport`; `.not` is part of the chain we don't care about.
    expect(
      matchExpectCall(parseStatement(`await expect(loc).not.toBeInViewport();`))?.matcherName,
    ).toBe('toBeInViewport');
    expect(
      matchExpectCall(parseStatement(`await expect.soft(loc).toHaveCount(0);`))?.matcherName,
    ).toBe('toHaveCount');
  });
});
