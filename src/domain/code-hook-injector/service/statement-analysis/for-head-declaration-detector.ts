/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 *
 */

// Detects whether a `VariableDeclaration` belongs to the head of a
// `for` / `for...in` / `for...of` loop.
//
//   for (let i = 0; i < 3; i++) {}        ← `let i = 0` is the HEAD
//   for (let x of xs) {}                  ← `let x`     is the HEAD
//   for (let k in obj) {}                 ← `let k`     is the HEAD
//
// The Babel AST represents these as:
//
//   ForStatement    .init  = VariableDeclaration
//   ForInStatement  .left  = VariableDeclaration
//   ForOfStatement  .left  = VariableDeclaration
//
// Our Statement visitor MUST skip such declarations entirely: they
// can't be hoisted out into a preceding `let x;` and rewrapped,
// because then the loop head would lose its binding and JS would
// parse as an error. The outer loop itself is a compound statement
// we don't wrap, so the head declaration has no traceable site.

import type * as BabelTypes from '@babel/types';

type Types = typeof BabelTypes;

export type ForHeadDeclarationDetector = (
  declaration: BabelTypes.VariableDeclaration,
  parent: BabelTypes.Node,
) => boolean;

export function createForHeadDeclarationDetector(t: Types): ForHeadDeclarationDetector {
  return function isForHeadDeclaration(declaration, parent) {
    if (t.isForStatement(parent) && parent.init === declaration) return true;
    if ((t.isForInStatement(parent) || t.isForOfStatement(parent)) && parent.left === declaration) {
      return true;
    }
    return false;
  };
}
