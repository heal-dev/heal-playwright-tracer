/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Builds the AST nodes the plugin inserts in front of every
//
//   await expect(target).<chain>
//   await expect.soft(target).<chain>
//
// statement to produce a highlight screenshot of `target` before the
// assertion runs. The runtime helper `globalThis.__heal_expect_screenshot`
// no-ops when `target` isn't a Locator, so injection is unconditional —
// only the wrapping decision is made here (visible vs. hidden, hoist
// vs. no-hoist).
//
// Two modes, driven by the `hideExpectScreenshots` plugin option:
//
// 1. Visible (default) — the helper call is inserted as its own
//    sibling statement *before* the assertion. The Statement visitor
//    will revisit it and wrap it with the standard
//    `__heal_enter` / `__heal_ok` / `__heal_throw` trio, so the
//    capture shows up in the trace ndjson as a regular leaf step
//    carrying the `screenshot` field. The synthetic node has no
//    position in the user's file, so its `meta.source` comes from
//    `_healSyntheticSource` (see `meta-fields/source-snippet-extractor.ts`).
//
// 2. Hidden — the helper call goes into the assertion's own
//    `try` body (via `preTryStmts`), prefixed with the user-statement
//    style `await globalThis.__heal_expect_screenshot?.(…)`. No
//    `_traced` flag is set on the wrapper itself — that's the
//    Statement visitor's job. The screenshot lands on the
//    assertion's `__enter` event because that's the top of the
//    recorder's enter-stack when the helper runs.
//
// Hoisting (both modes) — if `target` is anything other than a bare
// `Identifier`, evaluating it twice (once for the screenshot, once
// for the assertion) is unsafe. The injector returns a hoist
// `VariableDeclaration` carrying a leading `@heal-tracer-ignore`
// directive so the hoist itself isn't traced, and **mutates the
// original `expect` call's first argument in place** so the
// assertion now references the hoisted binding. The user's source
// string in the trace is preserved by `extractSource` slicing the
// original file by `start`/`end` — those positions don't change
// when the AST argument is swapped.

import type * as BabelTypes from '@babel/types';
import type { Scope } from '@babel/traverse';
import { HEAL_IGNORE_DIRECTIVE } from '../statement-analysis/heal-ignore-directive';
import {
  HEAL_EXPECT_SCREENSHOT,
  HEAL_EXPECT_SCREENSHOT_AFTER,
} from '../../../trace-event-recorder/model/global-names';

type Types = typeof BabelTypes;

interface TracedNode {
  _traced?: boolean;
}

interface SyntheticSourceNode {
  _healSyntheticSource?: string;
}

export interface ExpectScreenshotInjection {
  /**
   * Optional hoist declaration to insert before the wrapped
   * assertion. Carries a `@heal-tracer-ignore` leading comment so
   * the Statement visitor leaves it alone. `null` when the target
   * was a bare Identifier (no hoist needed).
   */
  hoistDecl: BabelTypes.VariableDeclaration | null;

  /**
   * Visible-mode only: the `await globalThis.__heal_expect_screenshot?.(…)`
   * statement to `insertBefore` the assertion. Carries
   * `_healSyntheticSource` so the recorded `meta.source` reads
   * `await __heal_expect_screenshot(<target source>)` instead of
   * an empty string. `null` in hidden mode (the call goes into
   * `preTryStmts` instead — see `tryBodyStmt` below).
   */
  insertBeforeStmt: BabelTypes.ExpressionStatement | null;

  /**
   * Hidden-mode only: the helper call to prepend to the assertion's
   * own try-body. Marked `_traced = true` so the visitor doesn't
   * re-process it. `null` in visible mode.
   */
  tryBodyStmt: BabelTypes.ExpressionStatement | null;

  /**
   * Visible-mode only: the after-capture helper call — `await
   * globalThis.__heal_expect_screenshot_after?.(…)` — to insert as its
   * own sibling statement *after* the assertion. Like `insertBeforeStmt`
   * it carries the assertion's loc and a `_healSyntheticSource`, so the
   * Statement visitor re-visits and wraps it into a standalone leaf step
   * carrying the `rawScreenshot` field. Sitting after the assertion makes
   * it success-only — a throwing matcher propagates past it. `null` in
   * hidden mode.
   */
  insertAfterStmt: BabelTypes.ExpressionStatement | null;

  /**
   * Hidden-mode only: the after-capture helper call appended as the
   * LAST statement in the assertion's own try-body, so it fires only
   * when the matcher passed (a throw skips it). Marked `_traced` so it
   * stamps the assertion's enter event (`rawScreenshot`) rather than
   * becoming its own statement, and reuses the same (possibly hoisted)
   * target binding as the pre-snap. `null` in visible mode.
   */
  afterTryBodyStmt: BabelTypes.ExpressionStatement | null;
}

export interface ExpectScreenshotInjector {
  build(args: {
    scope: Scope;
    target: BabelTypes.Expression;
    originalCode: string | undefined | null;
    expectStmtLoc: BabelTypes.SourceLocation | null | undefined;
    expectCall: BabelTypes.CallExpression;
    mode: 'visible' | 'hidden';
    /**
     * Name of the outermost matcher (`toBeVisible`, `toBeInViewport`,
     * …) from the assertion chain. Used to opt out of the default
     * scroll-into-view for matchers whose outcome depends on viewport
     * position (`toBeInViewport`, `not.toBeInViewport`).
     */
    matcherName: string | null;
  }): ExpectScreenshotInjection;
}

// Matchers whose outcome depends on the target's viewport position —
// the helper must NOT scroll the target into view before capturing,
// or it would mask the assertion. There's just one such matcher in
// Playwright today, but the carve-out is keyed by name to make any
// future additions a one-line change.
const VIEWPORT_SENSITIVE_MATCHERS: ReadonlySet<string> = new Set(['toBeInViewport']);

function targetSourceString(
  target: BabelTypes.Expression,
  originalCode: string | undefined | null,
): string {
  const start = (target as { start?: number | null }).start;
  const end = (target as { end?: number | null }).end;
  if (originalCode && start != null && end != null) {
    return originalCode.slice(start, end);
  }
  // Synthetic / no-loc — fall back to a placeholder. In practice the
  // target always has a loc because it came from the user's source.
  return '…';
}

export function createExpectScreenshotInjector(t: Types): ExpectScreenshotInjector {
  function buildHelperCall(
    targetExpr: BabelTypes.Expression,
    scroll: boolean,
    globalName: string = HEAL_EXPECT_SCREENSHOT,
  ): BabelTypes.ExpressionStatement {
    const callee = t.memberExpression(t.identifier('globalThis'), t.identifier(globalName));
    const args: BabelTypes.Expression[] = [targetExpr];
    // Only emit the options arg when we need to override the default
    // (`scroll: true`), so the common-case generated code stays
    // minimal: `await globalThis.__heal_expect_screenshot?.(target)`.
    if (!scroll) {
      args.push(
        t.objectExpression([t.objectProperty(t.identifier('scroll'), t.booleanLiteral(false))]),
      );
    }
    const call = t.optionalCallExpression(callee, args, /* optional */ true);
    return t.expressionStatement(t.awaitExpression(call));
  }

  return {
    build({ scope, target, originalCode, expectStmtLoc, expectCall, mode, matcherName }) {
      const needsHoist = !t.isIdentifier(target);
      const scroll = matcherName == null || !VIEWPORT_SENSITIVE_MATCHERS.has(matcherName);

      let hoistDecl: BabelTypes.VariableDeclaration | null = null;
      let refIdent: BabelTypes.Expression;

      if (needsHoist) {
        const hoistId = scope.generateUidIdentifier('healExpectTarget');
        hoistDecl = t.variableDeclaration('const', [t.variableDeclarator(hoistId, target)]);
        // `@heal-tracer-ignore` so the hoist doesn't itself produce a
        // statement record in the trace.
        t.addComment(hoistDecl, 'leading', ` ${HEAL_IGNORE_DIRECTIVE}`, /* line */ true);
        // Retarget the assertion at the hoisted binding. The user's
        // original `expect(EXPR).…` source string in the trace is
        // unaffected because `extractSource` slices the file by the
        // expect statement's original `start`/`end`, which don't
        // change when we swap an argument.
        expectCall.arguments[0] = t.cloneNode(hoistId);
        refIdent = t.cloneNode(hoistId);
      } else {
        refIdent = t.cloneNode(target);
      }

      const targetSrc = targetSourceString(target, originalCode);
      const preSyntheticSource = `await __heal_expect_screenshot(${targetSrc})`;
      const afterSyntheticSource = `await __heal_expect_screenshot_after(${targetSrc})`;

      // `hideExpectScreenshots` governs BOTH captures symmetrically: the
      // pre-snap highlight and the post-pass raw snap are either both
      // their own steps (visible) or both folded onto the assertion
      // (hidden). The after-snap is always success-only — in visible mode
      // by sitting after the assertion (a throw skips the sibling); in
      // hidden mode by being the last statement in the assertion's try
      // body. Clone `refIdent` per use so the pre- and after-snap don't
      // share an AST node.
      if (mode === 'visible') {
        const pre = buildHelperCall(t.cloneNode(refIdent), scroll);
        // Carry the assertion's loc so the visitor's `if (!node.loc)`
        // guard passes and each synthetic line is wrapped on the next pass.
        if (expectStmtLoc) pre.loc = expectStmtLoc;
        (pre as SyntheticSourceNode)._healSyntheticSource = preSyntheticSource;

        const after = buildHelperCall(t.cloneNode(refIdent), scroll, HEAL_EXPECT_SCREENSHOT_AFTER);
        if (expectStmtLoc) after.loc = expectStmtLoc;
        (after as SyntheticSourceNode)._healSyntheticSource = afterSyntheticSource;

        return {
          hoistDecl,
          insertBeforeStmt: pre,
          tryBodyStmt: null,
          insertAfterStmt: after,
          afterTryBodyStmt: null,
        };
      }

      const pre = buildHelperCall(t.cloneNode(refIdent), scroll);
      (pre as TracedNode)._traced = true;

      const after = buildHelperCall(t.cloneNode(refIdent), scroll, HEAL_EXPECT_SCREENSHOT_AFTER);
      (after as TracedNode)._traced = true;

      return {
        hoistDecl,
        insertBeforeStmt: null,
        tryBodyStmt: pre,
        insertAfterStmt: null,
        afterTryBodyStmt: after,
      };
    },
  };
}
