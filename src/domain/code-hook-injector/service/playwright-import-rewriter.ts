/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */

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
