/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import type * as BabelTypes from '@babel/types';

type Types = typeof BabelTypes;

interface TracedNode {
  _traced?: boolean;
}

export interface HoistedVariableDeclaration {
  /** Names introduced by the declaration, flattened across destructuring. */
  bindingNames: Set<string>;
  /** `let x, y;` — the bindings hoisted out of the try block. */
  hoistDecl: BabelTypes.VariableDeclaration;
  /** `x = EXPR; y = EXPR;` — one per declarator that had an initializer. */
  assignments: BabelTypes.ExpressionStatement[];
  /** `{ x, y }` — shorthand object literal passed to `__ok`. */
  varsObject: BabelTypes.ObjectExpression;
}

export type VariableDeclarationHoister = (
  declaration: BabelTypes.VariableDeclaration,
) => HoistedVariableDeclaration;

export function createVariableDeclarationHoister(t: Types): VariableDeclarationHoister {
  return function hoistVariableDeclaration(declaration) {
    const bindingNames = new Set<string>();
    for (const d of declaration.declarations) {
      Object.keys(t.getBindingIdentifiers(d.id)).forEach((n) => bindingNames.add(n));
    }

    const hoistDecl = t.variableDeclaration(
      'let',
      [...bindingNames].map((n) => t.variableDeclarator(t.identifier(n))),
    );
    (hoistDecl as TracedNode)._traced = true;

    const assignments = declaration.declarations
      .filter((d) => d.init != null)
      .map((d) => {
        const stmt = t.expressionStatement(
          t.assignmentExpression('=', d.id as BabelTypes.LVal, d.init!),
        );
        (stmt as TracedNode)._traced = true;
        return stmt;
      });

    const varsObject = t.objectExpression(
      [...bindingNames].map((n) =>
        t.objectProperty(
          t.identifier(n),
          t.identifier(n),
          false,
          true, // shorthand: { count } ≡ { count: count }
        ),
      ),
    );

    return { bindingNames, hoistDecl, assignments, varsObject };
  };
}
