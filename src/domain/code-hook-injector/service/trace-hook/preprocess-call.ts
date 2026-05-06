/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Builds the per-statement pre-processor call:
//
//   await globalThis.__heal_preprocess?.(meta)
//
// Prepended inside the try block by the Statement visitor, BEFORE the
// user's leaf statement. The fixture composes every pre-processor
// registered through `configureTracer({ preProcessors: [...] })` into a
// single `globalThis.__heal_preprocess` function that loops over them
// in declaration order.
//
// Why an `await`: pre-processors are async by contract — they may need
// to talk to the page (DOM stamping, screenshot, IPC) and we want
// those side effects to complete before the user's next statement
// runs. The Babel plugin only emits this call when the enclosing
// function is async (see `async-enclosing-function-detector.ts`) — an
// `await` in a sync function is a syntax error.
//
// Why `globalThis.X?.(...)` and not a bare identifier: same reason as
// `__heal_enter` — `Function.prototype.toString` ships our
// instrumented code into a fresh VM (e.g. `page.evaluate(fn)`) where
// no global is installed, and a property lookup + optional call
// degrades to a silent no-op there. A bare identifier would throw
// `ReferenceError`.
//
// The generated `await` statement is tagged `_traced = true` so the
// Statement visitor doesn't recurse into it.

import type * as BabelTypes from '@babel/types';

type Types = typeof BabelTypes;

interface TracedNode {
  _traced?: boolean;
}

export type PreprocessCallBuilder = (
  globalName: string,
  meta: BabelTypes.Expression,
) => BabelTypes.ExpressionStatement;

export function createPreprocessCallBuilder(t: Types): PreprocessCallBuilder {
  return function buildPreprocessCall(globalName, meta) {
    const callee = t.memberExpression(t.identifier('globalThis'), t.identifier(globalName));
    const call = t.optionalCallExpression(callee, [meta], /* optional */ true);
    const stmt = t.expressionStatement(t.awaitExpression(call));
    (stmt as TracedNode)._traced = true;
    return stmt;
  };
}
