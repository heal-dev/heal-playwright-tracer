/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 */
import { transformSync } from '@babel/core';
import { parse } from '@babel/parser';
import codeHookInjector from '../../src/application/babel-playwright-tracer-plugin';

// Small wrapper around @babel/core that runs the code-hook injector
// against a source string and returns the generated code. A stable
// filename is used so the include-filter matches by default.
export function transform(
  code: string,
  opts: {
    filename?: string;
    pluginOptions?: Record<string, unknown>;
  } = {},
): string {
  const filename = opts.filename ?? '/repo/tests/example.test.ts';
  const result = transformSync(code, {
    filename,
    babelrc: false,
    configFile: false,
    sourceType: 'module',
    plugins: [[codeHookInjector, opts.pluginOptions ?? {}]],
  });
  if (!result || result.code == null) {
    throw new Error('transform produced no output');
  }
  return result.code;
}

// Parse a standalone expression/statement into an AST node so the
// pure predicates can be tested without running the full transform.
export function parseStatement(src: string) {
  const program = parse(src, { sourceType: 'module' });
  return program.program.body[0];
}

export function parseExpression(src: string) {
  const program = parse(src, { sourceType: 'module' });
  const first = program.program.body[0];
  if (first.type !== 'ExpressionStatement') {
    throw new Error(`expected ExpressionStatement, got ${first.type}`);
  }
  return first.expression;
}
