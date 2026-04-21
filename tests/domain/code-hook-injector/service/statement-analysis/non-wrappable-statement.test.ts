/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 *
 */

import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import _traverse, { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { createNonWrappableStatementPredicate } from '../../../../../src/domain/code-hook-injector/service/statement-analysis/non-wrappable-statement';
import { createCjsArtifactDetector } from '../../../../../src/domain/code-hook-injector/service/statement-analysis/cjs-artifact-detector';

// @babel/traverse CJS interop.
const traverse = (_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse;

const { isGeneratedModuleStatement } = createCjsArtifactDetector(t);
const isNonWrappable = createNonWrappableStatementPredicate(t, isGeneratedModuleStatement);

// Parse `src` and return the NodePath of the first statement that
// satisfies `pick`. Used so each test can drill into the exact node
// it wants to assert against (an inner declaration, an export child,
// etc.) without manual AST walking.
function findStatementPath(
  src: string,
  pick: (path: NodePath<t.Statement>) => boolean = () => true,
): NodePath<t.Statement> {
  const ast = parse(src, { sourceType: 'module' });
  let found: NodePath<t.Statement> | null = null;
  traverse(ast, {
    Statement(path) {
      if (!found && pick(path)) {
        found = path;
        path.stop();
      }
    },
  });
  if (!found) throw new Error(`no matching statement in: ${src}`);
  return found;
}

describe('isNonWrappableStatement', () => {
  it('skips FunctionDeclaration', () => {
    const p = findStatementPath(`function f() {}`);
    expect(isNonWrappable(p)).toBe(true);
  });

  it('skips ImportDeclaration', () => {
    const p = findStatementPath(`import { x } from 'y';`);
    expect(isNonWrappable(p)).toBe(true);
  });

  it('skips ExportNamedDeclaration', () => {
    const p = findStatementPath(`export const x = 1;`, (path) => path.isExportNamedDeclaration());
    expect(isNonWrappable(p)).toBe(true);
  });

  it('skips ExportDefaultDeclaration', () => {
    const p = findStatementPath(`export default 42;`, (path) => path.isExportDefaultDeclaration());
    expect(isNonWrappable(p)).toBe(true);
  });

  it('skips a statement whose parent is an ExportDeclaration (inner var decl of `export const x = 1;`)', () => {
    // When Babel traverses into ExportNamedDeclaration.declaration it
    // fires the Statement visitor on the inner VariableDeclaration —
    // this branch must be skipped or we'd corrupt the export.
    const p = findStatementPath(
      `export const x = 1;`,
      (path) => path.isVariableDeclaration() && path.parentPath.isExportDeclaration(),
    );
    expect(isNonWrappable(p)).toBe(true);
  });

  it('skips BlockStatement', () => {
    const p = findStatementPath(`{ const a = 1; }`, (path) => path.isBlockStatement());
    expect(isNonWrappable(p)).toBe(true);
  });

  it('skips EmptyStatement', () => {
    const p = findStatementPath(`;`, (path) => path.isEmptyStatement());
    expect(isNonWrappable(p)).toBe(true);
  });

  it('skips CJS-generated `var X = require("...")` declarations', () => {
    const p = findStatementPath(`var X = require('x');`);
    expect(isNonWrappable(p)).toBe(true);
  });

  it('skips `var X = _interopRequireDefault(require("..."))` declarations', () => {
    const p = findStatementPath(`var X = _interopRequireDefault(require('x'));`);
    expect(isNonWrappable(p)).toBe(true);
  });

  it('does NOT skip a user-authored expression statement', () => {
    const p = findStatementPath(`foo();`);
    expect(isNonWrappable(p)).toBe(false);
  });

  it('does NOT skip a user-authored VariableDeclaration', () => {
    const p = findStatementPath(`const x = 1;`);
    expect(isNonWrappable(p)).toBe(false);
  });

  it('does NOT skip a ReturnStatement', () => {
    // Parse inside a function so the return is valid.
    const ast = parse(`function f() { return 42; }`, { sourceType: 'module' });
    let p: NodePath<t.Statement> | null = null;
    traverse(ast, {
      ReturnStatement(path) {
        p = path as unknown as NodePath<t.Statement>;
        path.stop();
      },
    });
    expect(p && isNonWrappable(p)).toBe(false);
  });

  it('does NOT skip a ThrowStatement', () => {
    const p = findStatementPath(`throw new Error('x');`);
    expect(isNonWrappable(p)).toBe(false);
  });
});
