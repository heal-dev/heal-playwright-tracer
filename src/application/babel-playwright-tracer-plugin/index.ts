/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// heal-playwright-tracer — Babel plugin (code-hook injector)
//
// Injects the **trace hook** into test source files at statement
// boundaries. Every leaf statement is wrapped in:
//
//   {
//     __heal_enter({ file, startLine, ..., source: "STMT" });
//     let _threw = false;
//     try {
//       await __heal_preprocess?.(meta);   // only inside async functions
//       STMT;
//     } catch (_e) { _threw = true; __heal_throw(_e); throw _e; }
//     finally { if (!_threw) __heal_ok(vars?); }
//   }
//
// The trace-event-recorder implements __heal_enter/ok/throw at runtime
// and maintains a stack of active __enter events so depth/parentSeq/
// duration are derived at pop time.
//
// `__heal_preprocess` is the user-extensible seam: consumers register
// pre-processor functions via `configureTracer({ preProcessors: [...] })`
// in `playwright.config.ts`, and the fixture installs a single
// `globalThis.__heal_preprocess` that awaits each in turn. Emitted
// only when the enclosing function is async — sync statements skip the
// emit entirely (a statement inside a sync helper can't await).
//
// Sibling folders carry the shared decisions:
//   - ./trace-hook/           — wrapper builders (try/finally, meta literal)
//   - ./statement-analysis/   — predicates and classifiers (is this
//                                a leaf? should it be skipped? is the
//                                enclosing function async?)
//   - ./meta-fields/          — extractors for meta-object values
//                                (source snippet, rel file path,
//                                enclosing scope label, leading
//                                comment)
//   - ./traced-file-matcher.ts         file-level include filter
//   - ./playwright-import-rewriter.ts  program-level import mutation
//
// Usage from playwright.config.ts:
//
//   import { defineConfig } from '@playwright/test';
//   export default defineConfig({
//     ...({
//       '@playwright/test': {
//         babelPlugins: [
//           [require.resolve('@heal-dev/heal-playwright-tracer/code-hook-injector'),
//            { include: [/\/tests\//] }],
//         ],
//       },
//     } as any),
//   });
//
// Plugin options:
//   include : RegExp | string | function | Array<any of those>
//     Which files to instrument. Each entry matches against the absolute
//     filename. A string matches by `includes()`; a RegExp by `test()`;
//     a function by returning truthy. Default: instrument files whose
//     path contains "/tests/".
//
//   hideExpectScreenshots : boolean
//     Default `false`. The plugin injects an
//     `await __heal_expect_screenshot(target)` helper in front of every
//     `await expect(target).…` / `await expect.soft(target).…` so a
//     highlight screenshot lands on each assertion, independent of where
//     `expect` is imported from. The injected call is normally visible
//     in the trace as its own leaf statement. Set this to `true` to
//     hide the helper: it is folded into the assertion's own try-body
//     and the screenshot stamps onto the assertion's enter event
//     instead of getting its own.
//
// Every matched file has its `from '@playwright/test'` import
// transparently rewritten to `from '@heal-dev/heal-playwright-tracer'` so
// test authors can keep the standard Playwright import and still get our
// extended `test` with the trace auto-fixture attached.

import type * as BabelTypes from '@babel/types';
import type { PluginObj, PluginPass } from '@babel/core';
import type { NodePath } from '@babel/traverse';

import {
  buildMatcher,
  type Include,
} from '../../domain/code-hook-injector/service/traced-file-matcher';
import { createCjsArtifactDetector } from '../../domain/code-hook-injector/service/statement-analysis/cjs-artifact-detector';
import { createLeafStatementClassifier } from '../../domain/code-hook-injector/service/statement-analysis/leaf-statement-classifier';
import { createNonWrappableStatementPredicate } from '../../domain/code-hook-injector/service/statement-analysis/non-wrappable-statement';
import { isUnderHealIgnore } from '../../domain/code-hook-injector/service/statement-analysis/heal-ignore-directive';
import { createForHeadDeclarationDetector } from '../../domain/code-hook-injector/service/statement-analysis/for-head-declaration-detector';
import { createAsyncEnclosingFunctionDetector } from '../../domain/code-hook-injector/service/statement-analysis/async-enclosing-function-detector';
import { createEnclosingScopeLabeler } from '../../domain/code-hook-injector/service/meta-fields/enclosing-scope-labeler';
import { extractSource } from '../../domain/code-hook-injector/service/meta-fields/source-snippet-extractor';
import { extractLeadingComment } from '../../domain/code-hook-injector/service/meta-fields/leading-comment-extractor';
import { relFile } from '../../domain/code-hook-injector/service/meta-fields/relative-file-path';
import { createPlaywrightImportRewriter } from '../../domain/code-hook-injector/service/playwright-import-rewriter';
import { createGlobalTraceCallBuilder } from '../../domain/code-hook-injector/service/trace-hook/global-trace-call';
import { createEnterMetaLiteralBuilder } from '../../domain/code-hook-injector/service/trace-hook/enter-meta-literal';
import { createTryFinallyWrapperBuilder } from '../../domain/code-hook-injector/service/trace-hook/try-finally-wrapper';
import { createVariableDeclarationHoister } from '../../domain/code-hook-injector/service/trace-hook/variable-declaration-hoister';
import { createPreprocessCallBuilder } from '../../domain/code-hook-injector/service/trace-hook/preprocess-call';
import { createExpectCallDetector } from '../../domain/code-hook-injector/service/statement-analysis/expect-call-detector';
import { createExpectScreenshotInjector } from '../../domain/code-hook-injector/service/trace-hook/expect-screenshot-injector';
import { HEAL_ENTER, HEAL_PREPROCESS } from '../../domain/trace-event-recorder/model/global-names';

interface CodeHookInjectorOptions {
  include?: Include;
  rootDir?: string;
  hideExpectScreenshots?: boolean;
}

interface TracedNode {
  _traced?: boolean;
}

function codeHookInjector(
  api: { types: typeof BabelTypes },
  opts: CodeHookInjectorOptions = {},
): PluginObj<PluginPass> {
  const t = api.types;
  const CWD = opts.rootDir || process.cwd();
  const matches = buildMatcher(opts.include);
  const hideExpectScreenshots = opts.hideExpectScreenshots === true;

  const { isGeneratedModuleStatement } = createCjsArtifactDetector(t);
  const { isLeafStatement, kindOf, containsAwait } = createLeafStatementClassifier(t);
  const findScopeName = createEnclosingScopeLabeler(t);
  const isNonWrappableStatement = createNonWrappableStatementPredicate(
    t,
    isGeneratedModuleStatement,
  );
  const isForHeadDeclaration = createForHeadDeclarationDetector(t);
  const isAsyncEnclosing = createAsyncEnclosingFunctionDetector(t);
  const rewritePlaywrightImports = createPlaywrightImportRewriter(t);

  const callStmt = createGlobalTraceCallBuilder(t);
  const buildMeta = createEnterMetaLiteralBuilder(t, {
    kindOf,
    containsAwait,
    findScopeName,
    extractSource,
    extractLeadingComment,
    relFile,
  });
  const { buildTryFinally, buildThrewDecl } = createTryFinallyWrapperBuilder(t, callStmt);
  const hoistVariableDeclaration = createVariableDeclarationHoister(t);
  const buildPreprocessCall = createPreprocessCallBuilder(t);
  const expectCallDetector = createExpectCallDetector(t);
  const expectScreenshotInjector = createExpectScreenshotInjector(t);

  return {
    name: 'heal-playwright-tracer',
    visitor: {
      // Rewrite `@playwright/test` → `@heal-dev/heal-playwright-tracer` at
      // the top of every matched file. Runs before the Statement visitor
      // because Program.enter fires first. The user keeps the standard
      // Playwright import; our auto-fixture loads transparently.
      Program(programPath: NodePath<BabelTypes.Program>, state: PluginPass) {
        if (!matches(state.file.opts.filename || '')) return;
        rewritePlaywrightImports(programPath.node);
      },

      Statement(stmtPath: NodePath<BabelTypes.Statement>, state: PluginPass) {
        const node = stmtPath.node;

        // Don't recurse into our own generated wrapper.
        if ((node as TracedNode)._traced) return;
        // Babel sometimes hands us synthetic nodes without source locations.
        if (!node.loc) return;

        // File-level filter: only touch files the consumer opted in to.
        if (!matches(state.file.opts.filename || '')) return;

        // Author opt-out: a `// @heal-tracer-ignore` directive on this
        // statement or any enclosing function/block. Checked before
        // any hook family so an ignored statement emits no
        // enter/ok/throw and no preprocess.
        if (isUnderHealIgnore(stmtPath)) return;

        // Skip statement kinds that no hook family should wrap.
        if (isNonWrappableStatement(stmtPath)) return;

        // Only leaf statements get wrapped. Compound statements
        // (if/for/while/switch/try) are transparent — their inner
        // leaves will be visited independently.
        if (!isLeafStatement(node)) return;

        // From here on it's trace-hook-specific. When a second hook
        // family lands, extract the block below into a
        // `applyTraceHookIfLeaf(stmtPath, state)` function in
        // ./trace-hook/ and call it alongside the future families.

        const meta = buildMeta(state, stmtPath, node, CWD);

        // Optional pre-processor call inserted at the very start of
        // the try body. Gated on the enclosing function being async
        // because the call itself is `await __heal_preprocess?.(meta)`
        // — a syntax error in sync functions. Sync statements skip
        // the preprocess phase entirely and are still traced.
        // `cloneNode(meta)` so the same literal isn't shared between
        // the __heal_enter call and this one.
        const preTryStmts: BabelTypes.Statement[] = isAsyncEnclosing(stmtPath)
          ? [buildPreprocessCall(HEAL_PREPROCESS, t.cloneNode(meta))]
          : [];

        // expect-screenshot injection. The helper itself is `await
        // globalThis.__heal_expect_screenshot?.(target)` so we only
        // inject inside an async function — that's also where
        // `await expect(...)` can legally appear.
        const expectMatch = isAsyncEnclosing(stmtPath)
          ? expectCallDetector.matchExpectCall(node)
          : null;
        let pendingInsertBefore: BabelTypes.Statement[] | null = null;
        if (expectMatch) {
          const injection = expectScreenshotInjector.build({
            scope: stmtPath.scope,
            target: expectMatch.target,
            originalCode: (state.file as { code?: string }).code,
            expectStmtLoc: node.loc,
            expectCall: expectMatch.call,
            mode: hideExpectScreenshots ? 'hidden' : 'visible',
            matcherName: expectMatch.matcherName,
          });
          if (injection.hoistDecl || injection.insertBeforeStmt) {
            pendingInsertBefore = [];
            if (injection.hoistDecl) pendingInsertBefore.push(injection.hoistDecl);
            if (injection.insertBeforeStmt) pendingInsertBefore.push(injection.insertBeforeStmt);
          }
          if (injection.tryBodyStmt) preTryStmts.push(injection.tryBodyStmt);
        }

        if (t.isVariableDeclaration(node)) {
          // `const x = EXPR` can't be wrapped as-is — the binding
          // would be scoped to the try block and invisible downstream.
          // Hoist the bindings out, assign inside the try, pass a
          // vars object to __ok so the recorder can snapshot values.
          if (isForHeadDeclaration(node, stmtPath.parent)) return;

          const { hoistDecl, assignments, varsObject, bindingNames } =
            hoistVariableDeclaration(node);
          const okArgs = bindingNames.size ? [varsObject] : [];
          const { threwId, tryStmt } = buildTryFinally(
            stmtPath.scope,
            [...preTryStmts, ...assignments],
            okArgs,
          );

          stmtPath.replaceWithMultiple([
            callStmt(HEAL_ENTER, [meta]),
            hoistDecl,
            buildThrewDecl(threwId),
            tryStmt,
          ]);
          return;
        }

        // Every other leaf statement: wrap in a block with the
        // original statement inside the try body.
        (node as TracedNode)._traced = true;

        const { threwId, tryStmt } = buildTryFinally(stmtPath.scope, [...preTryStmts, node]);
        const wrapper = t.blockStatement([
          callStmt(HEAL_ENTER, [meta]),
          buildThrewDecl(threwId),
          tryStmt,
        ]);

        if (pendingInsertBefore) {
          stmtPath.replaceWithMultiple([...pendingInsertBefore, wrapper]);
        } else {
          stmtPath.replaceWith(wrapper);
        }
      },
    },
  };
}

export = codeHookInjector;
