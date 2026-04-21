/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */

import type * as BabelTypes from '@babel/types';

type Types = typeof BabelTypes;
type Node = BabelTypes.Node;

export interface CjsArtifactDetector {
  isRequireLike: (node: Node | null | undefined) => boolean;
  isGeneratedModuleStatement: (node: Node) => boolean;
}

export function createCjsArtifactDetector(t: Types): CjsArtifactDetector {
  const isRequireLike = (node: Node | null | undefined): boolean => {
    if (!node || !t.isCallExpression(node)) return false;
    const callee = node.callee;
    if (!t.isIdentifier(callee)) return false;
    if (callee.name === 'require') return true;
    if (/^_interop/.test(callee.name) && node.arguments.length > 0) {
      return isRequireLike(node.arguments[0] as Node);
    }
    return false;
  };

  const isGeneratedModuleStatement = (node: Node): boolean => {
    if (t.isVariableDeclaration(node)) {
      return node.declarations.every((d) => isRequireLike(d.init));
    }
    return false;
  };

  return { isRequireLike, isGeneratedModuleStatement };
}
