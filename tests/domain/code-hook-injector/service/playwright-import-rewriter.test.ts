import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import generate from '@babel/generator';
import * as t from '@babel/types';
import { createPlaywrightImportRewriter } from '../../../../src/domain/code-hook-injector/service/playwright-import-rewriter';

const gen = (generate as unknown as { default?: typeof generate }).default ?? generate;
const rewritePlaywrightImports = createPlaywrightImportRewriter(t);

function parseProgram(src: string): t.Program {
  return parse(src, { sourceType: 'module' }).program;
}

function print(program: t.Program): string {
  // Wrap the Program in a synthetic File node for @babel/generator,
  // which prefers to start from a File but accepts Program too.
  return gen(t.file(program)).code;
}

describe('rewritePlaywrightImports', () => {
  it('rewrites `from "@playwright/test"` to `from "@heal-dev/heal-playwright-tracer"`', () => {
    const program = parseProgram(`import { test, expect } from '@playwright/test';\nfoo();`);
    rewritePlaywrightImports(program);
    const out = print(program);
    expect(out).toMatch(/from\s+["']@heal-dev\/heal-playwright-tracer["']/);
    expect(out).not.toMatch(/@playwright\/test/);
  });

  it('leaves other imports alone', () => {
    const program = parseProgram(`import fs from 'fs';\nimport { test } from '@playwright/test';`);
    rewritePlaywrightImports(program);
    const out = print(program);
    expect(out).toMatch(/from\s+['"]fs['"]/);
    expect(out).toMatch(/from\s+["']@heal-dev\/heal-playwright-tracer["']/);
  });

  it('rewrites every matching import in the file (not just the first)', () => {
    // Two imports from @playwright/test on purpose — unusual but legal.
    // Both should be rewritten.
    const program = parseProgram(
      `import { test } from '@playwright/test';\nimport { expect } from '@playwright/test';`,
    );
    rewritePlaywrightImports(program);
    const out = print(program);
    const matches = out.match(/@heal-dev\/heal-playwright-tracer/g) ?? [];
    expect(matches).toHaveLength(2);
    expect(out).not.toMatch(/@playwright\/test/);
  });

  it('does NOT rewrite `require("@playwright/test")` calls', () => {
    // The rewriter only touches ImportDeclaration nodes; require()
    // calls are CallExpressions and stay untouched.
    const program = parseProgram(`const { test } = require('@playwright/test');\nfoo();`);
    rewritePlaywrightImports(program);
    const out = print(program);
    expect(out).toMatch(/require\(['"]@playwright\/test['"]\)/);
  });

  it('is a no-op on a file with no playwright imports', () => {
    const program = parseProgram(`import { x } from 'y';\nfoo();`);
    const before = print(program);
    rewritePlaywrightImports(program);
    const after = print(program);
    expect(after).toBe(before);
  });

  it('produces a new StringLiteral node (not a mutated original) so other plugins see a fresh source', () => {
    const program = parseProgram(`import { test } from '@playwright/test';`);
    const originalImport = program.body[0] as t.ImportDeclaration;
    const originalSource = originalImport.source;
    rewritePlaywrightImports(program);
    const rewrittenImport = program.body[0] as t.ImportDeclaration;
    expect(rewrittenImport.source).not.toBe(originalSource);
    expect(rewrittenImport.source.value).toBe('@heal-dev/heal-playwright-tracer');
  });
});
