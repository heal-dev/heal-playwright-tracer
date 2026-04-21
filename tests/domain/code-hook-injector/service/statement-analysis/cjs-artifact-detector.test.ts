/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 */
import { describe, it, expect } from 'vitest';
import * as t from '@babel/types';
import { parseStatement, parseExpression } from '../../../../helpers/transform';
import { createCjsArtifactDetector } from '../../../../../src/domain/code-hook-injector/service/statement-analysis/cjs-artifact-detector';

const { isRequireLike, isGeneratedModuleStatement } = createCjsArtifactDetector(t);

describe('isRequireLike', () => {
  it('detects bare require()', () => {
    const expr = parseExpression(`require('x')`);
    expect(isRequireLike(expr)).toBe(true);
  });

  it('detects _interopRequireDefault(require())', () => {
    const expr = parseExpression(`_interopRequireDefault(require('x'))`);
    expect(isRequireLike(expr)).toBe(true);
  });

  it('detects _interopRequireWildcard(require()) — the namespace variant', () => {
    // Babel's CJS transform emits this form for `import * as X from 'y'`.
    const expr = parseExpression(`_interopRequireWildcard(require('x'))`);
    expect(isRequireLike(expr)).toBe(true);
  });

  it('rejects plain calls', () => {
    const expr = parseExpression(`foo('x')`);
    expect(isRequireLike(expr)).toBe(false);
  });

  it('rejects non-call expressions', () => {
    const expr = parseExpression(`someVar`);
    expect(isRequireLike(expr)).toBe(false);
  });

  it('rejects null / undefined', () => {
    expect(isRequireLike(null)).toBe(false);
    expect(isRequireLike(undefined)).toBe(false);
  });

  it('rejects an _interop helper called with no arguments', () => {
    const expr = parseExpression(`_interopRequireDefault()`);
    expect(isRequireLike(expr)).toBe(false);
  });

  it('rejects an _interop helper wrapping something other than require()', () => {
    const expr = parseExpression(`_interopRequireDefault(foo())`);
    expect(isRequireLike(expr)).toBe(false);
  });
});

describe('isGeneratedModuleStatement', () => {
  it('detects `var X = require(Y)` created by CJS transform', () => {
    const node = parseStatement(`var X = require('x');`);
    expect(isGeneratedModuleStatement(node)).toBe(true);
  });

  it('detects `var X = _interopRequireDefault(require(Y))`', () => {
    const node = parseStatement(`var X = _interopRequireDefault(require('x'));`);
    expect(isGeneratedModuleStatement(node)).toBe(true);
  });

  it('does not flag user-authored variable declarations', () => {
    const node = parseStatement(`const x = 1;`);
    expect(isGeneratedModuleStatement(node)).toBe(false);
  });

  it('rejects a declaration list where only SOME declarators are require-like', () => {
    // All declarators must be require-like — if even one isn't, we must not
    // treat the whole statement as a CJS artifact. Otherwise we'd skip a
    // user-authored declaration that happens to live on the same line.
    const node = parseStatement(`var X = require('x'), Y = 5;`);
    expect(isGeneratedModuleStatement(node)).toBe(false);
  });

  it('rejects non-VariableDeclaration statements outright', () => {
    expect(isGeneratedModuleStatement(parseStatement(`foo();`))).toBe(false);
    expect(isGeneratedModuleStatement(parseStatement(`throw new Error();`))).toBe(false);
  });
});
