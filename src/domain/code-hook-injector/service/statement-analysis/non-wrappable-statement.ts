/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

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
