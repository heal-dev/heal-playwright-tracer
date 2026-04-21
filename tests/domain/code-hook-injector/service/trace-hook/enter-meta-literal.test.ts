/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 */
import { describe, it, expect } from 'vitest';
import * as t from '@babel/types';
import type { NodePath } from '@babel/traverse';
import type { PluginPass } from '@babel/core';
import { createEnterMetaLiteralBuilder } from '../../../../../src/domain/code-hook-injector/service/trace-hook/enter-meta-literal';

// The meta-literal builder composes six helpers:
//   kindOf, containsAwait, findScopeName, extractSource,
//   extractLeadingComment, relFile.
// We stub each one so the test asserts only on what this file does —
// namely, assembling the right fields in the right order with the
// right sources.
const stubHelpers = {
  kindOf: () => 'expression',
  containsAwait: () => false,
  findScopeName: () => 'test: sample',
  extractSource: (_code: string | undefined | null, _node: t.Node) => 'foo();',
  extractLeadingComment: (_node: t.Node): string | null => null,
  relFile: (_cwd: string, absFile: string | undefined | null) =>
    absFile ? `rel/${absFile.split('/').pop()}` : '<anonymous>',
};

// A minimal Babel node with the location info buildMeta reads.
function makeNode(): t.Node {
  const node = t.expressionStatement(t.callExpression(t.identifier('foo'), []));
  node.loc = {
    start: { line: 10, column: 4, index: 0 },
    end: { line: 10, column: 10, index: 6 },
    filename: '',
    identifierName: undefined,
  } as unknown as t.SourceLocation;
  return node;
}

function makeState(filename = '/repo/tests/a.test.ts'): PluginPass {
  return {
    file: {
      opts: { filename },
      code: 'foo();',
    },
  } as unknown as PluginPass;
}

// Look up a field on the emitted ObjectExpression by its key name.
function field(obj: t.ObjectExpression, name: string): t.Expression | undefined {
  for (const prop of obj.properties) {
    if (t.isObjectProperty(prop) && t.isIdentifier(prop.key, { name }) && !prop.computed) {
      return prop.value as t.Expression;
    }
  }
  return undefined;
}

describe('buildEnterMetaLiteral', () => {
  const buildMeta = createEnterMetaLiteralBuilder(t, stubHelpers);

  it('emits an ObjectExpression with all nine meta fields in order (no comment)', () => {
    const obj = buildMeta(makeState(), {} as NodePath, makeNode(), '/repo');
    expect(t.isObjectExpression(obj)).toBe(true);
    const keys = obj.properties.map((p) =>
      t.isObjectProperty(p) && t.isIdentifier(p.key) ? p.key.name : '?',
    );
    expect(keys).toEqual([
      'file',
      'startLine',
      'startCol',
      'endLine',
      'endCol',
      'kind',
      'scope',
      'hasAwait',
      'source',
    ]);
    expect(keys).toHaveLength(9);
  });

  it('appends leadingComment as a tenth field when the extractor returns a string', () => {
    const buildMetaWithComment = createEnterMetaLiteralBuilder(t, {
      ...stubHelpers,
      extractLeadingComment: () => 'click the button',
    });
    const obj = buildMetaWithComment(makeState(), {} as NodePath, makeNode(), '/repo');
    const keys = obj.properties.map((p) =>
      t.isObjectProperty(p) && t.isIdentifier(p.key) ? p.key.name : '?',
    );
    expect(keys).toHaveLength(10);
    expect(keys[9]).toBe('leadingComment');
    expect((field(obj, 'leadingComment') as t.StringLiteral).value).toBe('click the button');
  });

  it('omits leadingComment entirely when the extractor returns null', () => {
    const obj = buildMeta(makeState(), {} as NodePath, makeNode(), '/repo');
    expect(field(obj, 'leadingComment')).toBeUndefined();
  });

  it('populates file from relFile(cwd, state.file.opts.filename)', () => {
    const obj = buildMeta(
      makeState('/repo/tests/checkout.test.ts'),
      {} as NodePath,
      makeNode(),
      '/repo',
    );
    const file = field(obj, 'file') as t.StringLiteral;
    expect(file.value).toBe('rel/checkout.test.ts');
  });

  it('populates start/end lines and columns from node.loc', () => {
    const obj = buildMeta(makeState(), {} as NodePath, makeNode(), '/repo');
    expect((field(obj, 'startLine') as t.NumericLiteral).value).toBe(10);
    expect((field(obj, 'startCol') as t.NumericLiteral).value).toBe(4);
    expect((field(obj, 'endLine') as t.NumericLiteral).value).toBe(10);
    expect((field(obj, 'endCol') as t.NumericLiteral).value).toBe(10);
  });

  it('populates kind from kindOf(node)', () => {
    const obj = buildMeta(makeState(), {} as NodePath, makeNode(), '/repo');
    expect((field(obj, 'kind') as t.StringLiteral).value).toBe('expression');
  });

  it('populates scope from findScopeName(nodePath)', () => {
    const obj = buildMeta(makeState(), {} as NodePath, makeNode(), '/repo');
    expect((field(obj, 'scope') as t.StringLiteral).value).toBe('test: sample');
  });

  it('populates hasAwait from containsAwait(node)', () => {
    const obj = buildMeta(makeState(), {} as NodePath, makeNode(), '/repo');
    expect((field(obj, 'hasAwait') as t.BooleanLiteral).value).toBe(false);
  });

  it('populates source from extractSource(state.file.code, node)', () => {
    const obj = buildMeta(makeState(), {} as NodePath, makeNode(), '/repo');
    expect((field(obj, 'source') as t.StringLiteral).value).toBe('foo();');
  });

  it('passes the real cwd through to relFile', () => {
    const captured: Array<[string, string | undefined | null]> = [];
    const buildMetaWithSpy = createEnterMetaLiteralBuilder(t, {
      ...stubHelpers,
      relFile: (cwd, absFile) => {
        captured.push([cwd, absFile]);
        return 'captured.ts';
      },
    });
    buildMetaWithSpy(makeState('/repo/tests/a.ts'), {} as NodePath, makeNode(), '/some/root');
    expect(captured).toEqual([['/some/root', '/repo/tests/a.ts']]);
  });
});
