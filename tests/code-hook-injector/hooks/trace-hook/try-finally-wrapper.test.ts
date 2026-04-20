import { describe, it, expect } from 'vitest';
import generate from '@babel/generator';
import * as t from '@babel/types';
import type { Scope } from '@babel/traverse';
import { createTryFinallyWrapperBuilder } from '../../../../src/code-hook-injector/hooks/trace-hook/try-finally-wrapper';

// CJS interop quirk.
const gen = (generate as unknown as { default?: typeof generate }).default ?? generate;
function print(node: t.Node): string {
  return gen(node).code;
}

// Stub the global-trace-call builder so we can assert on the exact
// `__heal_throw` / `__heal_ok` calls the wrapper emits without
// depending on the real builder's output.
const callStmt = (name: string, args: t.Expression[]) => {
  const stmt = t.expressionStatement(
    t.callExpression(t.memberExpression(t.identifier('globalThis'), t.identifier(name)), args),
  );
  (stmt as { _traced?: boolean })._traced = true;
  return stmt;
};

// Fake Babel Scope that returns predictable identifier names. The
// real Scope's generateUidIdentifier uses a program-wide counter; we
// only need unique names per distinct `name` argument, and since
// buildTryFinally passes two distinct names ('traceErr', 'traceThrew')
// the trivial `_<name>` scheme is collision-free here.
function makeFakeScope(): Scope {
  return {
    generateUidIdentifier: (name: string) => t.identifier(`_${name}`),
  } as unknown as Scope;
}

const { buildTryFinally, buildThrewDecl } = createTryFinallyWrapperBuilder(t, callStmt);

describe('buildThrewDecl', () => {
  it('emits `let _traceThrew = false;` with the provided identifier', () => {
    const id = t.identifier('_traceThrew');
    const decl = buildThrewDecl(id);
    expect(print(decl)).toBe('let _traceThrew = false;');
    expect(decl.kind).toBe('let');
  });

  it('tags the declaration with _traced=true', () => {
    const decl = buildThrewDecl(t.identifier('_traceThrew')) as t.VariableDeclaration & {
      _traced?: boolean;
    };
    expect(decl._traced).toBe(true);
  });
});

describe('buildTryFinally', () => {
  it('wraps the body in a try { } catch (err) { … } finally { if (!threw) __heal_ok(); }', () => {
    const scope = makeFakeScope();
    const body = [t.expressionStatement(t.callExpression(t.identifier('userCode'), []))];
    const { tryStmt } = buildTryFinally(scope, body);

    const printed = print(tryStmt);
    // Spot-check each structural piece rather than matching exact whitespace.
    expect(printed).toMatch(/try\s*\{[\s\S]*userCode\(\)[\s\S]*\}/);
    expect(printed).toMatch(/catch\s*\(_traceErr\)/);
    expect(printed).toMatch(/_traceThrew = true/);
    expect(printed).toMatch(/globalThis\.__heal_throw\(_traceErr\)/);
    expect(printed).toMatch(/throw _traceErr/);
    expect(printed).toMatch(/finally\s*\{[\s\S]*if\s*\(!_traceThrew\)[\s\S]*globalThis\.__heal_ok/);
  });

  it('returns a TryStatement AST with a catch clause and a finally block', () => {
    const { tryStmt } = buildTryFinally(makeFakeScope(), [
      t.expressionStatement(t.identifier('x')),
    ]);
    expect(t.isTryStatement(tryStmt)).toBe(true);
    expect(tryStmt.handler).not.toBeNull();
    expect(tryStmt.finalizer).not.toBeNull();
  });

  it('reuses the same generated identifier in the catch param and in the rethrow', () => {
    // Both sites must reference the *same* error binding or the
    // rethrow would silently refer to an undeclared name.
    const { tryStmt } = buildTryFinally(makeFakeScope(), [
      t.expressionStatement(t.identifier('x')),
    ]);
    const catchParam = tryStmt.handler!.param as t.Identifier;
    const rethrow = tryStmt.handler!.body.body.find((s) =>
      t.isThrowStatement(s),
    ) as t.ThrowStatement;
    const thrownId = rethrow.argument as t.Identifier;
    expect(catchParam.name).toBe(thrownId.name);
  });

  it('passes okArgs through to the __heal_ok call inside finally', () => {
    const varsObj = t.objectExpression([
      t.objectProperty(t.identifier('x'), t.identifier('x'), false, true),
    ]);
    const { tryStmt } = buildTryFinally(
      makeFakeScope(),
      [t.expressionStatement(t.identifier('x'))],
      [varsObj],
    );
    // The finally block has one if-statement; its consequent contains
    // the __heal_ok call with our varsObj as the sole argument.
    const ifStmt = tryStmt.finalizer!.body[0] as t.IfStatement;
    const okCall = ((ifStmt.consequent as t.BlockStatement).body[0] as t.ExpressionStatement)
      .expression as t.CallExpression;
    expect(okCall.arguments).toHaveLength(1);
    expect(t.isObjectExpression(okCall.arguments[0])).toBe(true);
  });

  it('omits __heal_ok args when okArgs is empty', () => {
    const { tryStmt } = buildTryFinally(makeFakeScope(), [
      t.expressionStatement(t.identifier('x')),
    ]);
    const ifStmt = tryStmt.finalizer!.body[0] as t.IfStatement;
    const okCall = ((ifStmt.consequent as t.BlockStatement).body[0] as t.ExpressionStatement)
      .expression as t.CallExpression;
    expect(okCall.arguments).toHaveLength(0);
  });

  it('returns a threwId matching the declarator the caller should declare', () => {
    // The caller emits `let <threwId> = false;` via buildThrewDecl.
    // buildTryFinally is responsible for choosing that identifier name
    // and must return it so both sites stay in sync.
    const { threwId } = buildTryFinally(makeFakeScope(), [
      t.expressionStatement(t.identifier('x')),
    ]);
    expect(t.isIdentifier(threwId)).toBe(true);
    expect(threwId.name).toMatch(/^_traceThrew/);
  });

  it('tags the generated try statement with _traced=true', () => {
    const { tryStmt } = buildTryFinally(makeFakeScope(), [
      t.expressionStatement(t.identifier('x')),
    ]);
    expect((tryStmt as t.TryStatement & { _traced?: boolean })._traced).toBe(true);
  });
});
