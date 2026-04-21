/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 *
 */

import { describe, it, expect } from 'vitest';
import generate from '@babel/generator';
import * as t from '@babel/types';
import { createGlobalTraceCallBuilder } from '../../../../../src/domain/code-hook-injector/service/trace-hook/global-trace-call';

// @babel/generator's default export — same CJS interop quirk as traverse.
const gen = (generate as unknown as { default?: typeof generate }).default ?? generate;

const buildGlobalTraceCall = createGlobalTraceCallBuilder(t);

function print(node: t.Node): string {
  return gen(node).code;
}

describe('buildGlobalTraceCall', () => {
  it('emits `globalThis.<name>?.(args)` — the optional-chained global call pattern', () => {
    const stmt = buildGlobalTraceCall('__heal_enter', [t.numericLiteral(42)]);
    expect(print(stmt)).toBe('globalThis.__heal_enter?.(42);');
  });

  it('uses an OptionalCallExpression with optional=true (not a bare CallExpression)', () => {
    // This is the single most important shape assertion in the whole
    // instrumenter — if this ever regresses to a bare identifier call,
    // instrumented code crashes the moment Playwright stringifies a
    // callback into a browser VM.
    const stmt = buildGlobalTraceCall('__heal_ok', []);
    expect(t.isExpressionStatement(stmt)).toBe(true);
    const expr = stmt.expression;
    expect(t.isOptionalCallExpression(expr)).toBe(true);
    expect((expr as t.OptionalCallExpression).optional).toBe(true);
  });

  it('uses a MemberExpression rooted at the `globalThis` identifier', () => {
    // Property lookup on globalThis (not a bare identifier reference)
    // is what prevents ReferenceError in environments where __heal_enter
    // doesn't exist.
    const stmt = buildGlobalTraceCall('__heal_throw', [t.identifier('err')]);
    const callee = (stmt.expression as t.OptionalCallExpression).callee;
    expect(t.isMemberExpression(callee)).toBe(true);
    const member = callee as t.MemberExpression;
    expect(t.isIdentifier(member.object, { name: 'globalThis' })).toBe(true);
    expect(t.isIdentifier(member.property, { name: '__heal_throw' })).toBe(true);
  });

  it('passes arguments through unchanged', () => {
    const args = [t.stringLiteral('a'), t.numericLiteral(2), t.booleanLiteral(false)];
    const stmt = buildGlobalTraceCall('__heal_enter', args);
    const call = stmt.expression as t.OptionalCallExpression;
    expect(call.arguments).toHaveLength(3);
    expect((call.arguments[0] as t.StringLiteral).value).toBe('a');
    expect((call.arguments[1] as t.NumericLiteral).value).toBe(2);
    expect((call.arguments[2] as t.BooleanLiteral).value).toBe(false);
  });

  it('accepts different global names', () => {
    expect(print(buildGlobalTraceCall('__heal_enter', []))).toBe('globalThis.__heal_enter?.();');
    expect(print(buildGlobalTraceCall('__heal_ok', []))).toBe('globalThis.__heal_ok?.();');
    expect(print(buildGlobalTraceCall('__heal_throw', []))).toBe('globalThis.__heal_throw?.();');
  });

  it('tags the generated statement with _traced=true so the visitor does not recurse into it', () => {
    const stmt = buildGlobalTraceCall('__heal_enter', []) as t.ExpressionStatement & {
      _traced?: boolean;
    };
    expect(stmt._traced).toBe(true);
  });
});
