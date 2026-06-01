/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Predicate + extractor: "is this leaf statement an `await expect(X)…`
// (or `await expect.soft(X)…`) chain, and if so, what is `X`?"
//
// Used by the Babel plugin to decide whether to inject the
// `__heal_expect_screenshot(X)` helper line in front of an assertion.
// `expect.poll(fn, …)` is deliberately excluded — `fn` is a function
// callback, not a locator, so the helper would always no-op.
//
// Matched shape (the inner expect call's first argument is the
// "target"):
//
//   await expect(target).toBeVisible()
//   await expect(target).not.toHaveText("…")
//   await expect.soft(target).toHaveCount(0)
//   await expect(target, "custom message").toBeVisible()
//
// Not matched:
//
//   expect(value).toBe(2)            // sync assertion (no `await`)
//   await expect.poll(() => x).toBe(…)
//   const e = expect; await e(loc).toBeVisible()   // aliased
//
// The aliased case is rare in practice and the failure mode is
// "no screenshot," matching today's behavior — we don't try to track
// aliases at compile time.

import type * as BabelTypes from '@babel/types';

type Types = typeof BabelTypes;

export interface ExpectCallMatch {
  /** The first-argument expression — the target the user passed to `expect(...)`. */
  target: BabelTypes.Expression;
  /**
   * The `expect(target, …)` / `expect.soft(target, …)` CallExpression
   * itself. Exposed so the injector can swap `arguments[0]` to point
   * at a hoisted binding without re-walking the chain.
   */
  call: BabelTypes.CallExpression;
  /**
   * Name of the outermost matcher method invoked on the chain — e.g.
   * `"toBeVisible"`, `"toHaveText"`, `"toBeInViewport"`. `null` if the
   * outermost call's callee shape doesn't resolve to a plain
   * identifier (rare; user did something unusual like `expect(x)[k]()`).
   * The injector uses this to opt out of pre-screenshot scroll for
   * `toBeInViewport`, whose outcome depends on viewport position.
   */
  matcherName: string | null;
}

export interface ExpectCallDetector {
  /**
   * Returns the root `expect(…)` call (with its first-argument target)
   * if `stmt` is `await expect(X)…` or `await expect.soft(X)…`, else
   * `null`.
   */
  matchExpectCall(stmt: BabelTypes.Statement): ExpectCallMatch | null;
}

export function createExpectCallDetector(t: Types): ExpectCallDetector {
  function isExpectRootCall(call: BabelTypes.CallExpression): boolean {
    const callee = call.callee;
    if (t.isIdentifier(callee, { name: 'expect' })) return true;
    if (
      t.isMemberExpression(callee) &&
      !callee.computed &&
      t.isIdentifier(callee.object, { name: 'expect' }) &&
      t.isIdentifier(callee.property, { name: 'soft' })
    ) {
      return true;
    }
    return false;
  }

  function outermostMatcherName(awaitArg: BabelTypes.Node): string | null {
    if (!t.isCallExpression(awaitArg)) return null;
    const callee = awaitArg.callee;
    if (!t.isMemberExpression(callee) || callee.computed) return null;
    if (!t.isIdentifier(callee.property)) return null;
    return callee.property.name;
  }

  return {
    matchExpectCall(stmt) {
      if (!t.isExpressionStatement(stmt)) return null;
      const top = stmt.expression;
      if (!t.isAwaitExpression(top)) return null;

      const matcherName = outermostMatcherName(top.argument);

      // Walk down the matcher chain to find the root `expect(…)` (or
      // `expect.soft(…)`) call. Chains look like:
      //   CallExpr(.toBeVisible)
      //     ↳ callee: MemberExpr (.toBeVisible on …)
      //         ↳ object: MemberExpr (.not on …) | CallExpr (expect(loc))
      // so at each step we descend into either `callExpr.callee` or
      // `memberExpr.object` until we hit a CallExpression whose callee
      // is `expect` or `expect.soft`.
      let node: BabelTypes.Node = top.argument;
      while (t.isCallExpression(node) || t.isMemberExpression(node)) {
        if (t.isCallExpression(node)) {
          if (isExpectRootCall(node)) {
            const first = node.arguments[0];
            if (!first || !t.isExpression(first)) return null;
            return { target: first, call: node, matcherName };
          }
          node = node.callee;
          continue;
        }
        node = node.object;
      }
      return null;
    },
  };
}
