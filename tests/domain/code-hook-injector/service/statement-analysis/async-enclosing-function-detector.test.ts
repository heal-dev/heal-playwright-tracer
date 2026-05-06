/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import _traverse, { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { createAsyncEnclosingFunctionDetector } from '../../../../../src/domain/code-hook-injector/service/statement-analysis/async-enclosing-function-detector';

// @babel/traverse CJS interop — same pattern used elsewhere in tests.
const traverse = (_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse;

const isAsyncEnclosing = createAsyncEnclosingFunctionDetector(t);

// Parse `src` and return the NodePath of the FIRST ExpressionStatement
// the visitor encounters. Each test seeds an `ExpressionStatement` at a
// specific position in the source and asserts the predicate on it.
function pickFirstExpressionStatement(src: string): NodePath<t.ExpressionStatement> {
  const ast = parse(src, { sourceType: 'module' });
  let found: NodePath<t.ExpressionStatement> | null = null;
  traverse(ast, {
    ExpressionStatement(path) {
      if (!found) {
        found = path;
        path.stop();
      }
    },
  });
  if (!found) throw new Error(`no ExpressionStatement in: ${src}`);
  return found;
}

describe('isAsyncEnclosing', () => {
  it('returns true for a leaf inside an async function declaration', () => {
    const p = pickFirstExpressionStatement(`async function f() { foo(); }`);
    expect(isAsyncEnclosing(p)).toBe(true);
  });

  it('returns true for a leaf inside an async arrow', () => {
    const p = pickFirstExpressionStatement(`const f = async () => { foo(); };`);
    expect(isAsyncEnclosing(p)).toBe(true);
  });

  it('returns true for a leaf inside an async object method', () => {
    const p = pickFirstExpressionStatement(`const o = { async m() { foo(); } };`);
    expect(isAsyncEnclosing(p)).toBe(true);
  });

  it('returns true for a leaf inside an async class method', () => {
    const p = pickFirstExpressionStatement(`class C { async m() { foo(); } }`);
    expect(isAsyncEnclosing(p)).toBe(true);
  });

  it('returns false for a leaf inside a sync function declaration', () => {
    const p = pickFirstExpressionStatement(`function f() { foo(); }`);
    expect(isAsyncEnclosing(p)).toBe(false);
  });

  it('returns false for a leaf inside a sync arrow', () => {
    const p = pickFirstExpressionStatement(`const f = () => { foo(); };`);
    expect(isAsyncEnclosing(p)).toBe(false);
  });

  it('returns false for a leaf inside a sync class method', () => {
    const p = pickFirstExpressionStatement(`class C { m() { foo(); } }`);
    expect(isAsyncEnclosing(p)).toBe(false);
  });

  it('honors the IMMEDIATE enclosing function — sync arrow nested in an async function is sync', () => {
    const src = `async function outer() { (function inner() { foo(); })(); }`;
    const ast = parse(src, { sourceType: 'module' });
    // Find the `foo();` ExpressionStatement specifically — the IIFE
    // call site is also an ExpressionStatement and would match first.
    let found: NodePath<t.ExpressionStatement> | null = null;
    traverse(ast, {
      ExpressionStatement(path) {
        const expr = path.node.expression;
        if (t.isCallExpression(expr) && t.isIdentifier(expr.callee, { name: 'foo' })) {
          found = path;
          path.stop();
        }
      },
    });
    expect(found && isAsyncEnclosing(found)).toBe(false);
  });

  it('honors the IMMEDIATE enclosing function — async arrow nested in a sync function is async', () => {
    const src = `function outer() { (async () => { foo(); })(); }`;
    const ast = parse(src, { sourceType: 'module' });
    // Pick the `foo();` ExpressionStatement specifically (the IIFE
    // call site is also an ExpressionStatement and would match first).
    let found: NodePath<t.ExpressionStatement> | null = null;
    traverse(ast, {
      ExpressionStatement(path) {
        const expr = path.node.expression;
        if (t.isCallExpression(expr) && t.isIdentifier(expr.callee, { name: 'foo' })) {
          found = path;
          path.stop();
        }
      },
    });
    expect(found && isAsyncEnclosing(found)).toBe(true);
  });

  it('returns false for a leaf at module top level (no enclosing function)', () => {
    const p = pickFirstExpressionStatement(`foo();`);
    expect(isAsyncEnclosing(p)).toBe(false);
  });
});
