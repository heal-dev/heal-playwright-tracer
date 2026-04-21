/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */
// Detects statements synthesized by @babel/plugin-transform-modules-commonjs.
//
// Playwright runs the CJS modules transform BEFORE our instrumenter,
// so by the time our Statement visitor fires, a user's top-of-file
// `import X from 'y'` has already become `var _y = require('y')` or
// `var _y = _interopRequireDefault(require('y'))`. Both forms look
// like a normal `VariableDeclaration` to the visitor — and if we
// wrapped them in our try/catch/finally, the first `__enter` call
// would fire before the recorder module has been required, hitting a
// `ReferenceError: __enter is not defined`.
//
// This detector is the escape hatch: the visitor calls
// `isGeneratedModuleStatement(node)` at the top of every statement
// callback and bails out if it returns true.

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
