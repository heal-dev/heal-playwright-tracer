/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 */
// Rewrites `from '@playwright/test'` to `from '@heal-dev/heal-playwright-tracer'`
// in a Program node.
//
// Runs once per file from the Program visitor, BEFORE the Statement
// visitor fires (Program.enter beats per-node visitors). Mutates the
// import declarations in place — every matched
// `ImportDeclaration.source` string literal gets replaced.
//
// Why this exists: test authors write the standard Playwright import:
//
//   import { test, expect } from '@playwright/test';
//
// and we want them to get OUR extended `test` with the auto-fixture
// attached, without having to change a line of their code. Swapping
// the import source at AST-rewrite time is the minimally-invasive
// way to do it. Downstream modules transforms turn the import into
// whatever the target module format needs.
//
// Only `ImportDeclaration` nodes are touched — `require('@playwright/test')`
// calls (CJS) are left alone. Consumers using `require()` should
// still use `import` in test files, or opt in explicitly by importing
// from `@heal-dev/heal-playwright-tracer` directly.

import type * as BabelTypes from '@babel/types';

type Types = typeof BabelTypes;

const PLAYWRIGHT_IMPORT_SOURCE = '@playwright/test';
const REPLACEMENT_SOURCE = '@heal-dev/heal-playwright-tracer';

export type PlaywrightImportRewriter = (program: BabelTypes.Program) => void;

export function createPlaywrightImportRewriter(t: Types): PlaywrightImportRewriter {
  return function rewritePlaywrightImports(program) {
    for (const node of program.body) {
      if (
        t.isImportDeclaration(node) &&
        node.source &&
        node.source.value === PLAYWRIGHT_IMPORT_SOURCE
      ) {
        node.source = t.stringLiteral(REPLACEMENT_SOURCE);
      }
    }
  };
}
