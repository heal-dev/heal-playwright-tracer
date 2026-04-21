/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 *
 */

import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import _traverse, { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { createEnclosingScopeLabeler } from '../../../../../src/domain/code-hook-injector/service/meta-fields/enclosing-scope-labeler';

// @babel/traverse's default export is the function itself, but under
// vitest's CJS interop it lands on `.default`. Normalize.
const traverse = (_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse;

const labelEnclosingScope = createEnclosingScopeLabeler(t);

// Parse `src` and return the NodePath of its first ExpressionStatement.
// Every test case wraps a `marker();` call in different enclosing
// contexts so we can assert the scope label assigned to that inner
// statement.
function pathToMarker(src: string): NodePath {
  const ast = parse(src, { sourceType: 'module' });
  let found: NodePath | null = null;
  traverse(ast, {
    ExpressionStatement(path) {
      const expr = path.node.expression;
      if (
        t.isCallExpression(expr) &&
        t.isIdentifier(expr.callee) &&
        expr.callee.name === 'marker'
      ) {
        found = path;
        path.stop();
      }
    },
  });
  if (!found) throw new Error(`marker() not found in: ${src}`);
  return found;
}

describe('labelEnclosingScope', () => {
  it('returns <module> for a top-level statement with no enclosing function', () => {
    const p = pathToMarker(`marker();`);
    expect(labelEnclosingScope(p)).toBe('<module>');
  });

  it('returns the name of a named function declaration', () => {
    const p = pathToMarker(`function doThing() { marker(); }`);
    expect(labelEnclosingScope(p)).toBe('doThing');
  });

  it('labels a test() callback with "test: <title>"', () => {
    const p = pathToMarker(`test('checkout happy path', async () => { marker(); });`);
    expect(labelEnclosingScope(p)).toBe('test: checkout happy path');
  });

  it('labels a describe() callback with "describe: <title>"', () => {
    const p = pathToMarker(`describe('auth suite', () => { marker(); });`);
    expect(labelEnclosingScope(p)).toBe('describe: auth suite');
  });

  it('labels a step() callback with "step: <title>"', () => {
    const p = pathToMarker(`step('fill form', () => { marker(); });`);
    expect(labelEnclosingScope(p)).toBe('step: fill form');
  });

  it('picks up method-style test APIs like test.describe("...", ...)', () => {
    // MemberExpression callee — labeler reads callee.property.name.
    const p = pathToMarker(`test.describe('nested', () => { marker(); });`);
    expect(labelEnclosingScope(p)).toBe('describe: nested');
  });

  it('falls back to "<name>()" when a test API callback has no string title', () => {
    const p = pathToMarker(`test(() => { marker(); });`);
    expect(labelEnclosingScope(p)).toBe('test()');
  });

  it('labels an arrow assigned to a variable with the variable name', () => {
    const p = pathToMarker(`const handler = () => { marker(); };`);
    expect(labelEnclosingScope(p)).toBe('handler');
  });

  it('labels an object-literal method with the method key name', () => {
    const p = pathToMarker(`const o = { doThing() { marker(); } };`);
    expect(labelEnclosingScope(p)).toBe('doThing');
  });

  it('labels a class method with the method key name', () => {
    const p = pathToMarker(`class X { run() { marker(); } }`);
    expect(labelEnclosingScope(p)).toBe('run');
  });

  it('falls back to <anonymous> for an IIFE with no enclosing context', () => {
    const p = pathToMarker(`(() => { marker(); })();`);
    expect(labelEnclosingScope(p)).toBe('<anonymous>');
  });

  it('recognizes all test API names (it, beforeEach, afterEach, beforeAll, afterAll)', () => {
    const cases: Array<[string, string]> = [
      [`it('does thing', () => { marker(); });`, 'it: does thing'],
      [`beforeEach(() => { marker(); });`, 'beforeEach()'],
      [`afterEach(() => { marker(); });`, 'afterEach()'],
      [`beforeAll(() => { marker(); });`, 'beforeAll()'],
      [`afterAll(() => { marker(); });`, 'afterAll()'],
    ];
    for (const [src, expected] of cases) {
      expect(labelEnclosingScope(pathToMarker(src))).toBe(expected);
    }
  });
});
