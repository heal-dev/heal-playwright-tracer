import { describe, it, expect } from 'vitest';
import * as t from '@babel/types';
import { parseStatement } from '../../../../helpers/transform';
import { createLeafStatementClassifier } from '../../../../../src/domain/code-hook-injector/service/statement-analysis/leaf-statement-classifier';

const { isLeafStatement, kindOf, containsAwait } = createLeafStatementClassifier(t);

describe('isLeafStatement / kindOf', () => {
  it('maps each statement type to its kind label', () => {
    const cases: Array<[string, string]> = [
      [`foo();`, 'expression'],
      [`const a = 1;`, 'variable'],
      [`return 1;`, 'return'],
      [`throw new Error();`, 'throw'],
      [`debugger;`, 'debugger'],
    ];
    for (const [src, kind] of cases) {
      const body =
        kind === 'return'
          ? (parseStatement(`function f(){ return 1; }`) as any).body.body[0]
          : kind === 'throw'
            ? (parseStatement(`function f(){ throw new Error(); }`) as any).body.body[0]
            : parseStatement(src);
      expect(isLeafStatement(body)).toBe(true);
      expect(kindOf(body)).toBe(kind);
    }
  });

  it('classifies break and continue inside a loop', () => {
    const loop = parseStatement(`for (;;) { break; }`) as any;
    const breakNode = loop.body.body[0];
    expect(isLeafStatement(breakNode)).toBe(true);
    expect(kindOf(breakNode)).toBe('break');

    const loop2 = parseStatement(`for (;;) { continue; }`) as any;
    const continueNode = loop2.body.body[0];
    expect(isLeafStatement(continueNode)).toBe(true);
    expect(kindOf(continueNode)).toBe('continue');
  });

  it('rejects block statements', () => {
    const node = parseStatement(`{ const a = 1; }`);
    expect(isLeafStatement(node)).toBe(false);
  });

  it('rejects compound statements (if/for/while/try)', () => {
    expect(isLeafStatement(parseStatement(`if (x) y();`))).toBe(false);
    expect(isLeafStatement(parseStatement(`for (;;) {}`))).toBe(false);
    expect(isLeafStatement(parseStatement(`while (x) {}`))).toBe(false);
    expect(isLeafStatement(parseStatement(`try {} catch (e) {}`))).toBe(false);
  });

  it('kindOf falls back to node.type for non-leaf statements', () => {
    const ifNode = parseStatement(`if (x) y();`);
    expect(kindOf(ifNode)).toBe('IfStatement');
  });
});

describe('containsAwait', () => {
  it('finds a top-level await in an expression statement', () => {
    const node = parseStatement(`await foo();`);
    expect(containsAwait(node)).toBe(true);
  });

  it('ignores awaits nested inside a deeper arrow function', () => {
    // The await here runs inside the nested arrow's own async context;
    // from the enclosing statement's perspective there is no await to
    // yield on. Tracing must not claim this statement is async.
    const node = parseStatement(`foo(async () => { await bar(); });`);
    expect(containsAwait(node)).toBe(false);
  });

  it('ignores awaits nested inside a deeper function expression', () => {
    const node = parseStatement(`foo(async function(){ await bar(); });`);
    expect(containsAwait(node)).toBe(false);
  });

  it('still finds awaits on the synchronous path', () => {
    const node = parseStatement(`const x = (await a()) + b;`);
    expect(containsAwait(node)).toBe(true);
  });

  it('returns false for a synchronous statement with no await at all', () => {
    const node = parseStatement(`const x = 1 + 2;`);
    expect(containsAwait(node)).toBe(false);
  });

  it('finds awaits through member chains and call arguments', () => {
    expect(containsAwait(parseStatement(`const a = b.c(await d()).e;`))).toBe(true);
    expect(containsAwait(parseStatement(`foo(bar, baz, await qux());`))).toBe(true);
  });
});
