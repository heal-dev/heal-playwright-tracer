/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import type * as BabelTypes from '@babel/types';

type Types = typeof BabelTypes;
type Node = BabelTypes.Node;

export interface LeafStatementClassifier {
  isLeafStatement: (node: Node) => boolean;
  kindOf: (node: Node) => string;
  containsAwait: (node: Node) => boolean;
}

export function createLeafStatementClassifier(t: Types): LeafStatementClassifier {
  const isLeafStatement = (node: Node): boolean =>
    t.isExpressionStatement(node) ||
    t.isVariableDeclaration(node) ||
    t.isReturnStatement(node) ||
    t.isThrowStatement(node) ||
    t.isBreakStatement(node) ||
    t.isContinueStatement(node) ||
    t.isDebuggerStatement(node);

  const kindOf = (node: Node): string => {
    if (t.isExpressionStatement(node)) return 'expression';
    if (t.isVariableDeclaration(node)) return 'variable';
    if (t.isReturnStatement(node)) return 'return';
    if (t.isThrowStatement(node)) return 'throw';
    if (t.isBreakStatement(node)) return 'break';
    if (t.isContinueStatement(node)) return 'continue';
    if (t.isDebuggerStatement(node)) return 'debugger';
    return node.type;
  };

  const containsAwait = (node: Node): boolean => {
    let found = false;
    const walk = (n: unknown): void => {
      if (!n || found || typeof n !== 'object') return;
      const asNode = n as Node;
      if (t.isAwaitExpression(asNode)) {
        found = true;
        return;
      }
      if (t.isFunction(asNode)) return;
      for (const key of Object.keys(asNode)) {
        if (key === 'loc' || key === 'type' || key === 'start' || key === 'end') continue;
        const v = (asNode as unknown as Record<string, unknown>)[key];
        if (v == null) continue;
        if (Array.isArray(v)) {
          for (const item of v) if (item && (item as Node).type) walk(item);
        } else if ((v as Node).type) {
          walk(v);
        }
      }
    };
    walk(node);
    return found;
  };

  return { isLeafStatement, kindOf, containsAwait };
}
