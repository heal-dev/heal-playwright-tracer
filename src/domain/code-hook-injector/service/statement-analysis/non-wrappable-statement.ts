/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */
// Predicate: "should the Statement visitor refuse to wrap this node?"
//
// Returns true for every statement kind that the injector must leave
// untouched, regardless of hook family. A matched file can still
// contain these nodes — we just skip them at the visitor level.
//
// The rules, in order:
//
//   1. FunctionDeclaration — hoisted declarations, not statements to
//      trace. Their bodies get visited independently.
//   2. ImportDeclaration — ESM imports. Skipped outright; rewriting
//      them to `from '@heal-dev/heal-playwright-tracer'` is the Program
//      visitor's job (see ./playwright-import-rewriter.ts), not the
//      Statement visitor's.
//   3. ExportDeclaration (named or default) — same reasoning; we
//      don't wrap the export machinery itself.
//   4. Parent is an ExportDeclaration — covers the case where Babel
//      traverses into `ExportNamedDeclaration.declaration` and fires
//      the Statement visitor on the inner `VariableDeclaration`.
//      Without this guard we'd call `replaceWithMultiple` on a
//      single-node slot and corrupt the export.
//   5. BlockStatement / EmptyStatement — not leaves; their contents
//      get visited individually.
//   6. CJS-require artifacts — delegated to
//      ./cjs-artifact-detector.ts. These are synthetic
//      `var _x = require('y')` statements Babel's CJS modules
//      transform emitted before our visitor ran. Wrapping them would
//      call __enter before the recorder module was loaded.

import type * as BabelTypes from '@babel/types';
import type { NodePath } from '@babel/traverse';

type Types = typeof BabelTypes;

export type NonWrappableStatementPredicate = (path: NodePath<BabelTypes.Statement>) => boolean;

export function createNonWrappableStatementPredicate(
  t: Types,
  isGeneratedModuleStatement: (node: BabelTypes.Node) => boolean,
): NonWrappableStatementPredicate {
  return function isNonWrappableStatement(path) {
    const node = path.node;
    return (
      t.isFunctionDeclaration(node) ||
      t.isImportDeclaration(node) ||
      t.isExportDeclaration(node) ||
      path.parentPath.isExportDeclaration() ||
      t.isBlockStatement(node) ||
      t.isEmptyStatement(node) ||
      isGeneratedModuleStatement(node)
    );
  };
}
