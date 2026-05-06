/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Predicate: "is the nearest enclosing function async?"
//
// Used by the Babel plugin to decide whether to emit the per-statement
// pre-processor call. The emit is `await globalThis.__heal_preprocess?.(meta)`
// — a syntax error in non-async functions, so we gate it on the
// nearest enclosing Function being declared `async`.
//
// Walk semantics — climb `parentPath` until the first node Babel
// classifies as a Function (FunctionDeclaration, FunctionExpression,
// ArrowFunctionExpression, ObjectMethod, ClassMethod). Return its
// `.async` flag. Stops at the first function: a sync arrow nested
// inside an async function is itself sync, and `await` inside it is
// illegal — what matters is the IMMEDIATE enclosing function.
//
// Statements at module top level (no enclosing function) return
// `false` — top-level await is technically legal in ESM modules but
// the Statement visitor already filters most module-level positions
// (imports/exports/CJS artifacts), and we don't want to pay the
// "what mode is the module?" complexity for a corner case nobody
// hits in Playwright tests.

import type * as BabelTypes from '@babel/types';
import type { NodePath } from '@babel/traverse';

type Types = typeof BabelTypes;

export type AsyncEnclosingFunctionDetector = (nodePath: NodePath) => boolean;

export function createAsyncEnclosingFunctionDetector(_t: Types): AsyncEnclosingFunctionDetector {
  return function isAsyncEnclosing(nodePath) {
    let p: NodePath | null = nodePath.parentPath;
    while (p) {
      if (p.isFunction()) {
        const fn = p.node as { async?: boolean };
        return fn.async === true;
      }
      p = p.parentPath;
    }
    return false;
  };
}
