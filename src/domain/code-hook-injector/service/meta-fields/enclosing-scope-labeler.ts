/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import type * as BabelTypes from '@babel/types';
import type { NodePath } from '@babel/traverse';

type Types = typeof BabelTypes;

export const TEST_API_NAMES = /^(test|it|describe|step|beforeEach|afterEach|beforeAll|afterAll)$/;

export type EnclosingScopeLabeler = (nodePath: NodePath) => string;

export function createEnclosingScopeLabeler(t: Types): EnclosingScopeLabeler {
  return function labelEnclosingScope(nodePath) {
    let p: NodePath | null = nodePath.parentPath;
    while (p) {
      if (p.isFunction()) {
        // ObjectMethod and ClassMethod ARE function nodes (not wrapped
        // by one), so we check them on the current path itself, not on
        // its parent. Must come BEFORE the named-function branch since
        // those methods can also have a `.key` we want to surface.
        if (p.isObjectMethod() || p.isClassMethod()) {
          const key = p.node.key;
          if (key && t.isIdentifier(key)) return key.name;
        }

        const fnNode = p.node;
        if ('id' in fnNode && fnNode.id && fnNode.id.name) return fnNode.id.name;

        const parent = p.parentPath;
        if (parent && parent.isCallExpression()) {
          const callee = parent.node.callee;
          let calleeName = '';
          if (t.isIdentifier(callee)) calleeName = callee.name;
          else if (t.isMemberExpression(callee) && t.isIdentifier(callee.property))
            calleeName = callee.property.name;

          if (TEST_API_NAMES.test(calleeName)) {
            const titleNode = parent.node.arguments[0];
            if (titleNode && t.isStringLiteral(titleNode)) {
              return `${calleeName}: ${titleNode.value}`;
            }
            return `${calleeName}()`;
          }
        }

        if (parent && parent.isVariableDeclarator() && t.isIdentifier(parent.node.id)) {
          return parent.node.id.name;
        }
        return '<anonymous>';
      }
      p = p.parentPath;
    }
    return '<module>';
  };
}
