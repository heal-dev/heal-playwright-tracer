/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 *
 */

import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { createForHeadDeclarationDetector } from '../../../../../src/domain/code-hook-injector/service/statement-analysis/for-head-declaration-detector';

const isForHeadDeclaration = createForHeadDeclarationDetector(t);

// Parse `src` and hand back (declaration, parent) for the first
// VariableDeclaration encountered inside the first top-level statement.
function pickFirstVarDecl(src: string): { declaration: t.VariableDeclaration; parent: t.Node } {
  const ast = parse(src, { sourceType: 'module' });
  const stmt = ast.program.body[0];
  // Walk the Babel AST once; Babel's own traverse is overkill here.
  let result: { declaration: t.VariableDeclaration; parent: t.Node } | null = null;
  const visit = (node: t.Node, parent: t.Node): void => {
    if (result) return;
    if (t.isVariableDeclaration(node)) {
      result = { declaration: node, parent };
      return;
    }
    for (const key of Object.keys(node) as Array<keyof typeof node>) {
      const v = (node as unknown as Record<string, unknown>)[key as string];
      if (v && typeof v === 'object' && !Array.isArray(v) && (v as t.Node).type) {
        visit(v as t.Node, node);
      } else if (Array.isArray(v)) {
        for (const item of v) {
          if (item && (item as t.Node).type) visit(item as t.Node, node);
        }
      }
    }
  };
  visit(stmt, ast.program);
  if (!result) throw new Error(`no VariableDeclaration in: ${src}`);
  return result;
}

describe('isForHeadDeclaration', () => {
  it('detects `for (let i = 0; ...; ...)` — ForStatement.init', () => {
    const { declaration, parent } = pickFirstVarDecl(`for (let i = 0; i < 3; i++) {}`);
    expect(isForHeadDeclaration(declaration, parent)).toBe(true);
  });

  it('detects `for (var i = 0; ...; ...)`', () => {
    const { declaration, parent } = pickFirstVarDecl(`for (var i = 0; i < 3; i++) {}`);
    expect(isForHeadDeclaration(declaration, parent)).toBe(true);
  });

  it('detects `for (let x of xs)` — ForOfStatement.left', () => {
    const { declaration, parent } = pickFirstVarDecl(`for (let x of xs) {}`);
    expect(isForHeadDeclaration(declaration, parent)).toBe(true);
  });

  it('detects `for (const k in obj)` — ForInStatement.left', () => {
    const { declaration, parent } = pickFirstVarDecl(`for (const k in obj) {}`);
    expect(isForHeadDeclaration(declaration, parent)).toBe(true);
  });

  it('does NOT flag a regular top-level const', () => {
    const declaration = parse(`const x = 1;`, { sourceType: 'module' }).program
      .body[0] as t.VariableDeclaration;
    const parent = { type: 'Program' } as unknown as t.Node;
    expect(isForHeadDeclaration(declaration, parent)).toBe(false);
  });

  it('does NOT flag a VariableDeclaration inside a for BODY', () => {
    // `for (let i = 0; i < n; i++) { const y = 1; }` — `const y` is in
    // the body, not the head. The head is `let i = 0`.
    const ast = parse(`for (let i = 0; i < 3; i++) { const y = 1; }`, {
      sourceType: 'module',
    });
    const forStmt = ast.program.body[0] as t.ForStatement;
    const body = forStmt.body as t.BlockStatement;
    const innerDecl = body.body[0] as t.VariableDeclaration;
    expect(isForHeadDeclaration(innerDecl, body)).toBe(false);
  });

  it('does NOT flag a non-declaration `for (;;)` head with no init', () => {
    // If the caller happens to hand us the ForStatement.init=null case,
    // the detector should simply return false (no VariableDeclaration
    // lives there, so the question doesn't apply).
    const ast = parse(`for (;;) {}`, { sourceType: 'module' });
    const forStmt = ast.program.body[0] as t.ForStatement;
    const fakeDecl = t.variableDeclaration('let', []);
    expect(isForHeadDeclaration(fakeDecl, forStmt)).toBe(false);
  });
});
