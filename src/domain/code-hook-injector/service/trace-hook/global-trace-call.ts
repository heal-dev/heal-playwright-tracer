/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 */
// Builds the call pattern that invokes the recorder from instrumented
// code: `globalThis.__enter?.(args)`.
//
// Why the optional chain on a global lookup instead of a bare
// identifier call (`__enter(args)`):
//
//   Playwright ships user callbacks to the browser via
//   `Function.prototype.toString()` — `page.evaluate(fn)` takes `fn`,
//   stringifies its body, and runs the result in a fresh VM inside
//   the page. If we emitted bare `__enter(...)` calls, that browser
//   VM (which has no such global) would throw `ReferenceError:
//   __enter is not defined` on the first traced statement.
//
//   `globalThis.__enter?.(...)` dodges this because:
//   - `globalThis.__enter` is a **property lookup**, not an identifier
//     lookup, so it returns `undefined` in any environment that
//     hasn't installed the global — no ReferenceError.
//   - The `?.` optional call short-circuits when the left side is
//     `null`/`undefined`, so the whole call is a silent no-op in any
//     such environment. Node-side execution is unchanged because
//     recorder.ts still installs `globalThis.__enter`.
//
//   Every AST-rewriting coverage tool (istanbul included) hits this
//   exact issue and solves it the same way.
//
// The generated statement is tagged with `_traced = true` so the
// Statement visitor won't recurse into it.

import type * as BabelTypes from '@babel/types';

type Types = typeof BabelTypes;

interface TracedNode {
  _traced?: boolean;
}

export type GlobalTraceCallBuilder = (
  name: string,
  args: BabelTypes.Expression[],
) => BabelTypes.ExpressionStatement;

export function createGlobalTraceCallBuilder(t: Types): GlobalTraceCallBuilder {
  return function buildGlobalTraceCall(name, args) {
    const callee = t.memberExpression(t.identifier('globalThis'), t.identifier(name));
    const stmt = t.expressionStatement(t.optionalCallExpression(callee, args, /* optional */ true));
    (stmt as TracedNode)._traced = true;
    return stmt;
  };
}
