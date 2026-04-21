/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

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
