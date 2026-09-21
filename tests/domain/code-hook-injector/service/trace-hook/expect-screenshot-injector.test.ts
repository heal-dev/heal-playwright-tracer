/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect } from 'vitest';
import generate from '@babel/generator';
import * as t from '@babel/types';
import type { Scope } from '@babel/traverse';
import { createExpectScreenshotInjector } from '../../../../../src/domain/code-hook-injector/service/trace-hook/expect-screenshot-injector';

const gen = (generate as unknown as { default?: typeof generate }).default ?? generate;
const injector = createExpectScreenshotInjector(t);

function print(node: t.Node): string {
  return gen(node).code;
}

// Minimal Scope stand-in. The injector only ever calls
// `generateUidIdentifier`, so a stub with a deterministic counter is
// enough — and lets the printed output be assertion-friendly.
function makeFakeScope(): Scope {
  let counter = 0;
  return {
    generateUidIdentifier(name: string) {
      counter += 1;
      const suffix = counter === 1 ? '' : String(counter);
      return t.identifier(`_${name}${suffix}`);
    },
  } as unknown as Scope;
}

// Build a CallExpression that looks like `expect(<target>)` so the
// injector has a real `expectCall.arguments[0]` to swap out.
function makeExpectCall(target: t.Expression): t.CallExpression {
  return t.callExpression(t.identifier('expect'), [target]);
}

describe('expect-screenshot injector', () => {
  describe('visible mode — Identifier target', () => {
    const target = t.identifier('heading');
    // The injector reads `target.start`/`target.end` to slice the
    // source for the synthetic-source string, so set positions that
    // match `await expect(heading).toBeVisible();`.
    (target as { start?: number; end?: number }).start = 13;
    (target as { start?: number; end?: number }).end = 20;
    const expectCall = makeExpectCall(target);
    const stmtLoc: t.SourceLocation = {
      start: { line: 3, column: 0, index: 0 },
      end: { line: 3, column: 36, index: 36 },
      filename: '',
      identifierName: undefined,
    };
    const result = injector.build({
      scope: makeFakeScope(),
      target,
      originalCode: 'await expect(heading).toBeVisible();',
      expectStmtLoc: stmtLoc,
      expectCall,
      mode: 'visible',
      matcherName: 'toBeVisible',
    });

    it('does NOT hoist when the target is a bare Identifier', () => {
      expect(result.hoistDecl).toBeNull();
    });

    it('returns the helper statement under `insertBeforeStmt`, not `tryBodyStmt`', () => {
      expect(result.insertBeforeStmt).not.toBeNull();
      expect(result.tryBodyStmt).toBeNull();
    });

    it('emits `await globalThis.__heal_expect_screenshot?.(heading)` with no options arg', () => {
      expect(print(result.insertBeforeStmt!)).toBe(
        'await globalThis.__heal_expect_screenshot?.(heading);',
      );
    });

    it('attaches the assertion statement’s loc so the visitor will re-visit and wrap it', () => {
      expect(result.insertBeforeStmt!.loc).toBe(stmtLoc);
    });

    it('carries the synthetic source via `_healSyntheticSource` for meta.source', () => {
      type WithSynthetic = t.ExpressionStatement & { _healSyntheticSource?: string };
      expect((result.insertBeforeStmt as WithSynthetic)._healSyntheticSource).toBe(
        'await __heal_expect_screenshot(heading)',
      );
    });

    it('leaves the original expect call’s first argument untouched (no retarget needed)', () => {
      expect(expectCall.arguments[0]).toBe(target);
    });

    it('does NOT tag the visible-mode statement with `_traced` (it must be visited)', () => {
      type Traced = t.ExpressionStatement & { _traced?: boolean };
      expect((result.insertBeforeStmt as Traced)._traced).toBeUndefined();
    });
  });

  describe('visible mode — non-Identifier target (hoist path)', () => {
    const target = t.callExpression(
      t.memberExpression(t.identifier('page'), t.identifier('getByRole')),
      [t.stringLiteral('heading')],
    );
    // Give the target byte positions so the injector can slice the
    // original source for the synthetic source string. Code shape:
    //   "await expect(page.getByRole(\"heading\")).toBeVisible();"
    //                 ^13                       ^38
    const originalCode = 'await expect(page.getByRole("heading")).toBeVisible();';
    const targetStart = originalCode.indexOf('page.getByRole');
    const targetEnd = originalCode.indexOf(')') + 1; // close-paren of getByRole
    (target as { start?: number; end?: number }).start = targetStart;
    (target as { start?: number; end?: number }).end = targetEnd;

    const expectCall = makeExpectCall(target);
    const result = injector.build({
      scope: makeFakeScope(),
      target,
      originalCode,
      expectStmtLoc: null,
      expectCall,
      mode: 'visible',
      matcherName: 'toBeVisible',
    });

    it('emits a hoist declaration that captures the target once', () => {
      expect(result.hoistDecl).not.toBeNull();
      expect(result.hoistDecl!.kind).toBe('const');
      expect(print(result.hoistDecl!)).toContain('_healExpectTarget = page.getByRole("heading")');
    });

    it('marks the hoist with a leading @heal-tracer-ignore comment', () => {
      const printed = print(result.hoistDecl!);
      expect(printed).toContain('@heal-tracer-ignore');
    });

    it('retargets the original expect call to reference the hoisted binding', () => {
      // The injector mutates expectCall.arguments[0] in place.
      expect(t.isIdentifier(expectCall.arguments[0], { name: '_healExpectTarget' })).toBe(true);
    });

    it('uses the hoisted binding (not the original expression) in the helper call', () => {
      expect(print(result.insertBeforeStmt!)).toBe(
        'await globalThis.__heal_expect_screenshot?.(_healExpectTarget);',
      );
    });

    it('carries the full original target source in `_healSyntheticSource`', () => {
      type WithSynthetic = t.ExpressionStatement & { _healSyntheticSource?: string };
      expect((result.insertBeforeStmt as WithSynthetic)._healSyntheticSource).toBe(
        'await __heal_expect_screenshot(page.getByRole("heading"))',
      );
    });
  });

  describe('hidden mode', () => {
    const target = t.identifier('heading');
    const expectCall = makeExpectCall(target);
    const result = injector.build({
      scope: makeFakeScope(),
      target,
      originalCode: 'await expect(heading).toBeVisible();',
      expectStmtLoc: null,
      expectCall,
      mode: 'hidden',
      matcherName: 'toBeVisible',
    });

    it('returns the helper statement under `tryBodyStmt`, not `insertBeforeStmt`', () => {
      expect(result.tryBodyStmt).not.toBeNull();
      expect(result.insertBeforeStmt).toBeNull();
    });

    it('tags the hidden-mode statement with `_traced=true` to prevent visitor recursion', () => {
      type Traced = t.ExpressionStatement & { _traced?: boolean };
      expect((result.tryBodyStmt as Traced)._traced).toBe(true);
    });

    it('does NOT attach `_healSyntheticSource` (the statement is not its own enter event)', () => {
      type WithSynthetic = t.ExpressionStatement & { _healSyntheticSource?: string };
      expect((result.tryBodyStmt as WithSynthetic)._healSyntheticSource).toBeUndefined();
    });

    it('emits the same helper call shape, ready to drop into a preTry list', () => {
      expect(print(result.tryBodyStmt!)).toBe(
        'await globalThis.__heal_expect_screenshot?.(heading);',
      );
    });
  });

  describe('viewport-sensitive matcher carve-out', () => {
    it('emits `{ scroll: false }` for `toBeInViewport`', () => {
      const target = t.identifier('loc');
      const result = injector.build({
        scope: makeFakeScope(),
        target,
        originalCode: 'await expect(loc).toBeInViewport();',
        expectStmtLoc: null,
        expectCall: makeExpectCall(target),
        mode: 'visible',
        matcherName: 'toBeInViewport',
      });
      expect(print(result.insertBeforeStmt!)).toBe(
        'await globalThis.__heal_expect_screenshot?.(loc, {\n  scroll: false\n});',
      );
    });

    it('omits the options arg for any other matcher (default scroll: true)', () => {
      const target = t.identifier('loc');
      const result = injector.build({
        scope: makeFakeScope(),
        target,
        originalCode: 'await expect(loc).toHaveText("x");',
        expectStmtLoc: null,
        expectCall: makeExpectCall(target),
        mode: 'visible',
        matcherName: 'toHaveText',
      });
      expect(print(result.insertBeforeStmt!)).toBe(
        'await globalThis.__heal_expect_screenshot?.(loc);',
      );
    });

    it('also applies the carve-out in hidden mode', () => {
      const target = t.identifier('loc');
      const result = injector.build({
        scope: makeFakeScope(),
        target,
        originalCode: 'await expect(loc).not.toBeInViewport();',
        expectStmtLoc: null,
        expectCall: makeExpectCall(target),
        mode: 'hidden',
        matcherName: 'toBeInViewport',
      });
      expect(print(result.tryBodyStmt!)).toBe(
        'await globalThis.__heal_expect_screenshot?.(loc, {\n  scroll: false\n});',
      );
    });

    it('defaults to scrolling when matcherName is null (chain with non-standard shape)', () => {
      // Defensive: an unusual chain like `expect(x)[k]()` produces a
      // null matcherName. The safe default is "scroll" — same as
      // every common matcher.
      const target = t.identifier('loc');
      const result = injector.build({
        scope: makeFakeScope(),
        target,
        originalCode: 'await expect(loc)[k]();',
        expectStmtLoc: null,
        expectCall: makeExpectCall(target),
        mode: 'visible',
        matcherName: null,
      });
      expect(print(result.insertBeforeStmt!)).toBe(
        'await globalThis.__heal_expect_screenshot?.(loc);',
      );
    });
  });

  describe('after-capture (success-only raw snap)', () => {
    type Traced = t.ExpressionStatement & { _traced?: boolean };
    type WithSynthetic = t.ExpressionStatement & { _healSyntheticSource?: string };

    it('visible mode — emits the after-capture as its OWN step under `insertAfterStmt`', () => {
      const target = t.identifier('heading');
      const result = injector.build({
        scope: makeFakeScope(),
        target,
        originalCode: 'await expect(heading).toBeVisible();',
        expectStmtLoc: null,
        expectCall: makeExpectCall(target),
        mode: 'visible',
        matcherName: 'toBeVisible',
      });
      // Lives under insertAfterStmt (its own sibling step), NOT folded
      // into the assertion's try body.
      expect(result.insertAfterStmt).not.toBeNull();
      expect(result.afterTryBodyStmt).toBeNull();
      expect(print(result.insertAfterStmt!)).toBe(
        'await globalThis.__heal_expect_screenshot_after?.(heading);',
      );
    });

    it('visible mode — the after step is NOT `_traced` and carries its own synthetic source', () => {
      // Symmetric with the pre-snap: it must be re-visited and wrapped
      // into a standalone leaf carrying the `rawScreenshot` field. Byte
      // positions match `await expect(heading)…` so the synthetic source
      // slices to `heading` rather than the no-loc `…` fallback.
      const target = t.identifier('heading');
      (target as { start?: number; end?: number }).start = 13;
      (target as { start?: number; end?: number }).end = 20;
      const result = injector.build({
        scope: makeFakeScope(),
        target,
        originalCode: 'await expect(heading).toBeVisible();',
        expectStmtLoc: null,
        expectCall: makeExpectCall(target),
        mode: 'visible',
        matcherName: 'toBeVisible',
      });
      expect((result.insertAfterStmt as Traced)._traced).toBeUndefined();
      expect((result.insertAfterStmt as WithSynthetic)._healSyntheticSource).toBe(
        'await __heal_expect_screenshot_after(heading)',
      );
    });

    it('hidden mode — folds the after-capture into the try body under `afterTryBodyStmt`, `_traced`', () => {
      const target = t.identifier('heading');
      const result = injector.build({
        scope: makeFakeScope(),
        target,
        originalCode: 'await expect(heading).toBeVisible();',
        expectStmtLoc: null,
        expectCall: makeExpectCall(target),
        mode: 'hidden',
        matcherName: 'toBeVisible',
      });
      expect(result.afterTryBodyStmt).not.toBeNull();
      expect(result.insertAfterStmt).toBeNull();
      expect((result.afterTryBodyStmt as Traced)._traced).toBe(true);
      expect(print(result.afterTryBodyStmt!)).toBe(
        'await globalThis.__heal_expect_screenshot_after?.(heading);',
      );
    });

    it('references the hoisted binding in the after-capture for non-Identifier targets', () => {
      const target = t.callExpression(
        t.memberExpression(t.identifier('page'), t.identifier('getByRole')),
        [t.stringLiteral('heading')],
      );
      const result = injector.build({
        scope: makeFakeScope(),
        target,
        originalCode: 'await expect(page.getByRole("heading")).toBeVisible();',
        expectStmtLoc: null,
        expectCall: makeExpectCall(target),
        mode: 'visible',
        matcherName: 'toBeVisible',
      });
      expect(print(result.insertAfterStmt!)).toBe(
        'await globalThis.__heal_expect_screenshot_after?.(_healExpectTarget);',
      );
    });
  });
});
