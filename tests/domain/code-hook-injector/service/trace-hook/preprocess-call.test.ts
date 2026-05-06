/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect } from 'vitest';
import generate from '@babel/generator';
import * as t from '@babel/types';
import { createPreprocessCallBuilder } from '../../../../../src/domain/code-hook-injector/service/trace-hook/preprocess-call';

// @babel/generator CJS interop — same pattern as the global-trace-call test.
const gen = (generate as unknown as { default?: typeof generate }).default ?? generate;

const buildPreprocessCall = createPreprocessCallBuilder(t);

function print(node: t.Node): string {
  return gen(node).code;
}

describe('buildPreprocessCall', () => {
  it('emits `await globalThis.<name>?.(meta);`', () => {
    const meta = t.objectExpression([
      t.objectProperty(t.identifier('file'), t.stringLiteral('a.ts')),
    ]);
    const stmt = buildPreprocessCall('__heal_preprocess', meta);
    expect(print(stmt)).toBe(`await globalThis.__heal_preprocess?.({\n  file: "a.ts"\n});`);
  });

  it('wraps an OptionalCallExpression (optional=true) in an AwaitExpression', () => {
    // The optional chain on the global lookup is what makes the call a
    // silent no-op in environments where the global is not installed
    // (browser VMs receiving stringified callbacks). The await keeps
    // pre-processors composable as async functions.
    const stmt = buildPreprocessCall('__heal_preprocess', t.identifier('m'));
    expect(t.isExpressionStatement(stmt)).toBe(true);
    const await_ = stmt.expression;
    expect(t.isAwaitExpression(await_)).toBe(true);
    const call = (await_ as t.AwaitExpression).argument;
    expect(t.isOptionalCallExpression(call)).toBe(true);
    expect((call as t.OptionalCallExpression).optional).toBe(true);
  });

  it('uses a MemberExpression rooted at `globalThis`', () => {
    const stmt = buildPreprocessCall('__heal_preprocess', t.identifier('m'));
    const await_ = stmt.expression as t.AwaitExpression;
    const call = await_.argument as t.OptionalCallExpression;
    expect(t.isMemberExpression(call.callee)).toBe(true);
    const member = call.callee as t.MemberExpression;
    expect(t.isIdentifier(member.object, { name: 'globalThis' })).toBe(true);
    expect(t.isIdentifier(member.property, { name: '__heal_preprocess' })).toBe(true);
  });

  it('passes the meta argument through unchanged', () => {
    const meta = t.objectExpression([
      t.objectProperty(t.identifier('startLine'), t.numericLiteral(7)),
    ]);
    const stmt = buildPreprocessCall('__heal_preprocess', meta);
    const call = (stmt.expression as t.AwaitExpression).argument as t.OptionalCallExpression;
    expect(call.arguments).toHaveLength(1);
    expect(call.arguments[0]).toBe(meta);
  });

  it('tags the generated statement with _traced=true so the visitor does not recurse', () => {
    const stmt = buildPreprocessCall(
      '__heal_preprocess',
      t.identifier('m'),
    ) as t.ExpressionStatement & {
      _traced?: boolean;
    };
    expect(stmt._traced).toBe(true);
  });

  it('accepts different global names', () => {
    const stmt = buildPreprocessCall('__custom', t.identifier('m'));
    expect(print(stmt)).toBe('await globalThis.__custom?.(m);');
  });
});
