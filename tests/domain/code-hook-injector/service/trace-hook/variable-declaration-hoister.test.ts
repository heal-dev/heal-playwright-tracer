/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import generate from '@babel/generator';
import * as t from '@babel/types';
import { createVariableDeclarationHoister } from '../../../../../src/domain/code-hook-injector/service/trace-hook/variable-declaration-hoister';

const gen = (generate as unknown as { default?: typeof generate }).default ?? generate;
const hoistVariableDeclaration = createVariableDeclarationHoister(t);

function parseVarDecl(src: string): t.VariableDeclaration {
  const ast = parse(src, { sourceType: 'module' });
  const stmt = ast.program.body[0];
  if (!t.isVariableDeclaration(stmt)) {
    throw new Error(`expected VariableDeclaration, got ${stmt.type}`);
  }
  return stmt;
}

function print(node: t.Node): string {
  return gen(node).code;
}

describe('hoistVariableDeclaration', () => {
  it('extracts a single binding name from a simple `const x = expr;`', () => {
    const decl = parseVarDecl(`const x = compute();`);
    const result = hoistVariableDeclaration(decl);
    expect([...result.bindingNames]).toEqual(['x']);
  });

  it('builds a `let x;` hoist declaration with no initializer', () => {
    const decl = parseVarDecl(`const x = compute();`);
    const { hoistDecl } = hoistVariableDeclaration(decl);
    expect(hoistDecl.kind).toBe('let');
    expect(print(hoistDecl)).toBe('let x;');
    expect(hoistDecl.declarations[0].init).toBe(null);
  });

  it('builds an assignment statement for each initialized declarator', () => {
    const decl = parseVarDecl(`const x = compute();`);
    const { assignments } = hoistVariableDeclaration(decl);
    expect(assignments).toHaveLength(1);
    expect(print(assignments[0])).toBe('x = compute();');
  });

  it('builds a `{ x }` shorthand object expression', () => {
    const decl = parseVarDecl(`const x = compute();`);
    const { varsObject } = hoistVariableDeclaration(decl);
    expect(t.isObjectExpression(varsObject)).toBe(true);
    expect(varsObject.properties).toHaveLength(1);
    const prop = varsObject.properties[0] as t.ObjectProperty;
    expect(prop.shorthand).toBe(true);
    expect((prop.key as t.Identifier).name).toBe('x');
  });

  it('handles multi-declarator statements: `const x = 1, y = 2;`', () => {
    const decl = parseVarDecl(`const x = 1, y = 2;`);
    const { bindingNames, hoistDecl, assignments, varsObject } = hoistVariableDeclaration(decl);
    expect([...bindingNames].sort()).toEqual(['x', 'y']);
    expect(print(hoistDecl)).toBe('let x, y;');
    expect(assignments).toHaveLength(2);
    expect(print(assignments[0])).toBe('x = 1;');
    expect(print(assignments[1])).toBe('y = 2;');
    expect(varsObject.properties).toHaveLength(2);
  });

  it('handles destructuring from an object pattern: `const { a, b } = o;`', () => {
    const decl = parseVarDecl(`const { a, b } = o;`);
    const { bindingNames, hoistDecl, assignments } = hoistVariableDeclaration(decl);
    expect([...bindingNames].sort()).toEqual(['a', 'b']);
    expect(print(hoistDecl)).toBe('let a, b;');
    // The assignment keeps the original ObjectPattern as the LHS.
    expect(assignments).toHaveLength(1);
    expect(print(assignments[0])).toMatch(/\{\s*a,\s*b\s*\}\s*=\s*o/);
  });

  it('handles nested destructuring: `const { a, b: [c] } = f();`', () => {
    const decl = parseVarDecl(`const { a, b: [c] } = f();`);
    const { bindingNames } = hoistVariableDeclaration(decl);
    // Both `a` and `c` should be extracted; `b` is a destructuring key,
    // not a binding name.
    expect([...bindingNames].sort()).toEqual(['a', 'c']);
  });

  it('omits assignments for declarators with no initializer', () => {
    // `let x;` (no initializer) — nothing to assign.
    const decl = parseVarDecl(`let x;`);
    const { hoistDecl, assignments, bindingNames } = hoistVariableDeclaration(decl);
    expect([...bindingNames]).toEqual(['x']);
    expect(print(hoistDecl)).toBe('let x;');
    expect(assignments).toHaveLength(0);
  });

  it('mixes initialized and uninitialized declarators in one statement', () => {
    const decl = parseVarDecl(`let x = 1, y, z = 3;`);
    const { bindingNames, assignments } = hoistVariableDeclaration(decl);
    expect([...bindingNames].sort()).toEqual(['x', 'y', 'z']);
    expect(assignments).toHaveLength(2); // only x and z had initializers
    expect(print(assignments[0])).toBe('x = 1;');
    expect(print(assignments[1])).toBe('z = 3;');
  });

  it('tags the hoisted declaration with _traced=true', () => {
    const decl = parseVarDecl(`const x = compute();`);
    const { hoistDecl } = hoistVariableDeclaration(decl);
    expect((hoistDecl as t.VariableDeclaration & { _traced?: boolean })._traced).toBe(true);
  });

  it('tags every generated assignment with _traced=true', () => {
    const decl = parseVarDecl(`const x = 1, y = 2;`);
    const { assignments } = hoistVariableDeclaration(decl);
    for (const assignment of assignments) {
      expect((assignment as t.ExpressionStatement & { _traced?: boolean })._traced).toBe(true);
    }
  });

  it('returns an empty varsObject when the declaration has no bindings (edge)', () => {
    // Pathological: a VariableDeclaration with zero declarators.
    // Real code can't produce this, but the builder shouldn't choke.
    const decl = t.variableDeclaration('let', []);
    const { bindingNames, hoistDecl, assignments, varsObject } = hoistVariableDeclaration(decl);
    expect(bindingNames.size).toBe(0);
    expect(hoistDecl.declarations).toHaveLength(0);
    expect(assignments).toHaveLength(0);
    expect(varsObject.properties).toHaveLength(0);
  });
});
