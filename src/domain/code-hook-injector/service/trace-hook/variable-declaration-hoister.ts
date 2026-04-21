/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Rewrites a `VariableDeclaration` into three AST fragments the
// trace-hook wrapper needs:
//
//   Input (original):
//     const x = compute(), y = 42;
//
//   Output (three AST fragments):
//     hoistDecl       : `let x, y;`
//     assignments     : [ `x = compute();`, `y = 42;` ]
//     varsObject      : `{ x, y }`
//     bindingNames    : Set { "x", "y" }
//
// The trace-hook visitor then emits:
//
//   __enter({...});
//   let x, y;                              <─ hoistDecl
//   let _traceThrew = false;
//   try {
//     x = compute();                       <─ assignments
//     y = 42;
//   } catch (e) { ... }
//   finally { if (!_threw) __ok({ x, y }); }  <─ varsObject
//
// Hoisting the bindings OUT of the try block keeps them visible to
// subsequent statements in the enclosing scope (a `const` declared
// inside a try is scoped to that try). Passing the `varsObject` to
// `__ok` lets the recorder snapshot the variable's value on
// successful completion — which is the whole reason
// VariableDeclarations need special treatment in the first place.
//
// Every generated AST node is tagged with `_traced = true` so the
// visitor doesn't re-enter them.
//
// Destructuring declarations work via `t.getBindingIdentifiers`,
// which recursively walks ObjectPattern / ArrayPattern / RestElement
// to produce every individual name. `const { a, b: [c] } = f();`
// yields `bindingNames = { a, c }`.

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
