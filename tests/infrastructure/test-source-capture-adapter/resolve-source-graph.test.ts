/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  resolveSourceGraph,
  type ParseSpecifiers,
} from '../../../src/infrastructure/test-source-capture-adapter/resolve-source-graph';

/** Helper: build a small fixture tree. Returns the rootDir. */
const buildTree = (files: Record<string, string>): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'heal-resolve-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return root;
};

/**
 * Mock parser: extracts string-literal arguments out of `import 'x'`,
 * `import ... from 'x'`, `export ... from 'x'`, dynamic `import('x')`
 * and `require('x')`. Lets the tests exercise resolution rules without
 * pulling in `@babel/parser`.
 */
const mockParser: ParseSpecifiers = (source) => {
  const out: string[] = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) out.push(m[1]);
  }
  return out;
};

describe('resolveSourceGraph', () => {
  it('returns [] when the entry file is outside the root', () => {
    const root = buildTree({ 'tests/a.spec.ts': '' });
    const out = resolveSourceGraph('/nowhere/elsewhere.ts', {
      rootDir: root,
      parseSpecifiers: mockParser,
    });
    expect(out).toEqual([]);
  });

  it('returns the entry file by itself when it has no imports', () => {
    const root = buildTree({ 'tests/a.spec.ts': '// nothing here\n' });
    const out = resolveSourceGraph(path.join(root, 'tests/a.spec.ts'), {
      rootDir: root,
      parseSpecifiers: mockParser,
    });
    expect(out).toHaveLength(1);
    expect(out[0].relPath).toBe('tests/a.spec.ts');
    expect(out[0].isEntry).toBe(true);
  });

  it('follows relative imports with extension inference', () => {
    const root = buildTree({
      'tests/a.spec.ts': "import { login } from '../pages/login';\n",
      'pages/login.ts': 'export const login = 1;\n',
    });
    const out = resolveSourceGraph(path.join(root, 'tests/a.spec.ts'), {
      rootDir: root,
      parseSpecifiers: mockParser,
    });
    expect(out.map((f) => f.relPath).sort()).toEqual(['pages/login.ts', 'tests/a.spec.ts']);
  });

  it('follows /index resolution', () => {
    const root = buildTree({
      'tests/a.spec.ts': "import { x } from '../pages';\n",
      'pages/index.ts': 'export const x = 1;\n',
    });
    const out = resolveSourceGraph(path.join(root, 'tests/a.spec.ts'), {
      rootDir: root,
      parseSpecifiers: mockParser,
    });
    expect(out.some((f) => f.relPath === 'pages/index.ts')).toBe(true);
  });

  it('follows dynamic import() and require()', () => {
    const root = buildTree({
      'tests/a.spec.ts': "const m = require('./helper'); import('./other');\n",
      'tests/helper.ts': '',
      'tests/other.ts': '',
    });
    const out = resolveSourceGraph(path.join(root, 'tests/a.spec.ts'), {
      rootDir: root,
      parseSpecifiers: mockParser,
    });
    const rels = out.map((f) => f.relPath).sort();
    expect(rels).toEqual(['tests/a.spec.ts', 'tests/helper.ts', 'tests/other.ts']);
  });

  it('drops bare specifiers (treated as node_modules)', () => {
    const root = buildTree({
      'tests/a.spec.ts': "import { test } from '@playwright/test';\nimport _ from 'lodash';\n",
    });
    const out = resolveSourceGraph(path.join(root, 'tests/a.spec.ts'), {
      rootDir: root,
      parseSpecifiers: mockParser,
    });
    expect(out.map((f) => f.relPath)).toEqual(['tests/a.spec.ts']);
  });

  it('drops files resolving inside node_modules', () => {
    const root = buildTree({
      'tests/a.spec.ts': "import x from '../node_modules/foo/dist/index';\n",
      'node_modules/foo/dist/index.ts': '',
    });
    const out = resolveSourceGraph(path.join(root, 'tests/a.spec.ts'), {
      rootDir: root,
      parseSpecifiers: mockParser,
    });
    expect(out.map((f) => f.relPath)).toEqual(['tests/a.spec.ts']);
  });

  it('is cycle-safe', () => {
    const root = buildTree({
      'tests/a.spec.ts': "import './b';\n",
      'tests/b.ts': "import './a.spec';\n",
    });
    const out = resolveSourceGraph(path.join(root, 'tests/a.spec.ts'), {
      rootDir: root,
      parseSpecifiers: mockParser,
    });
    const rels = out.map((f) => f.relPath).sort();
    expect(rels).toEqual(['tests/a.spec.ts', 'tests/b.ts']);
  });

  it('drops unresolved specifiers', () => {
    const root = buildTree({
      'tests/a.spec.ts': "import './missing';\nimport './present';\n",
      'tests/present.ts': '',
    });
    const out = resolveSourceGraph(path.join(root, 'tests/a.spec.ts'), {
      rootDir: root,
      parseSpecifiers: mockParser,
    });
    expect(out.map((f) => f.relPath).sort()).toEqual(['tests/a.spec.ts', 'tests/present.ts']);
  });

  it('honors tsconfig path aliases', () => {
    const root = buildTree({
      'tests/a.spec.ts': "import { x } from '@/pages/login';\n",
      'pages/login.ts': 'export const x = 1;\n',
    });
    const out = resolveSourceGraph(path.join(root, 'tests/a.spec.ts'), {
      rootDir: root,
      parseSpecifiers: mockParser,
      tsconfig: {
        baseUrl: root,
        paths: { '@/*': ['./*'] },
      },
    });
    expect(out.map((f) => f.relPath).sort()).toEqual(['pages/login.ts', 'tests/a.spec.ts']);
  });

  it('respects maxFiles cap', () => {
    const root = buildTree({
      'tests/a.spec.ts': "import './b';\nimport './c';\nimport './d';\n",
      'tests/b.ts': '',
      'tests/c.ts': '',
      'tests/d.ts': '',
    });
    const out = resolveSourceGraph(path.join(root, 'tests/a.spec.ts'), {
      rootDir: root,
      parseSpecifiers: mockParser,
      maxFiles: 2,
    });
    expect(out).toHaveLength(2);
    expect(out[0].isEntry).toBe(true);
  });

  it('respects maxDepth cap', () => {
    const root = buildTree({
      'tests/a.spec.ts': "import './b';\n",
      'tests/b.ts': "import './c';\n",
      'tests/c.ts': "import './d';\n",
      'tests/d.ts': '',
    });
    const out = resolveSourceGraph(path.join(root, 'tests/a.spec.ts'), {
      rootDir: root,
      parseSpecifiers: mockParser,
      maxDepth: 1,
    });
    const rels = out.map((f) => f.relPath).sort();
    // depth 0 = a.spec.ts, depth 1 = b.ts. c.ts (depth 2) is excluded.
    expect(rels).toEqual(['tests/a.spec.ts', 'tests/b.ts']);
  });

  it('marks only the entry file as isEntry', () => {
    const root = buildTree({
      'tests/a.spec.ts': "import './b';\nimport './c';\n",
      'tests/b.ts': '',
      'tests/c.ts': '',
    });
    const out = resolveSourceGraph(path.join(root, 'tests/a.spec.ts'), {
      rootDir: root,
      parseSpecifiers: mockParser,
    });
    expect(out.filter((f) => f.isEntry)).toHaveLength(1);
    expect(out.find((f) => f.relPath === 'tests/a.spec.ts')?.isEntry).toBe(true);
  });

  it('uses real @babel/parser when no parseSpecifiers seam is given', () => {
    // Smoke test: relies on @babel/parser being installed (it is — as a
    // transitive dep of the project's @babel/core devDependency).
    const root = buildTree({
      'tests/a.spec.ts':
        "import { foo as _foo } from './helper';\nimport type { T as _T } from './types';\n",
      'tests/helper.ts': 'export const foo = 1;\n',
      'tests/types.ts': 'export type T = number;\n',
    });
    const out = resolveSourceGraph(path.join(root, 'tests/a.spec.ts'), {
      rootDir: root,
    });
    expect(out.map((f) => f.relPath).sort()).toEqual([
      'tests/a.spec.ts',
      'tests/helper.ts',
      'tests/types.ts',
    ]);
  });
});
