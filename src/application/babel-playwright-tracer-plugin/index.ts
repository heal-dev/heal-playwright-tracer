// heal-playwright-tracer — Babel plugin (code-hook injector)
//
// Injects hooks into test source files at statement boundaries. Today
// the only hook family is the **trace hook**, which wraps every leaf
// statement in:
//
//   {
//     __enter({ file, startLine, ..., source: "STMT" });
//     let _threw = false;
//     try { STMT; }
//     catch (_e) { _threw = true; __throw(_e); throw _e; }
//     finally { if (!_threw) __ok(vars?); }
//   }
//
// The trace-event-recorder (see ./trace-event-recorder.ts) implements
// those global hooks at runtime — it maintains a stack of active
// __enter events so depth/parentSeq/duration are derived at pop time.
//
// Hook families live under ./hooks/. Today's only family is
// ./hooks/trace-hook/ — the try/catch/finally wrapper described
// above. Future hook families (regex-matched Playwright API calls,
// DOM-setup hooks, etc.) will add new siblings under
// ./hooks/custom-hooks/ and plug into the same Statement visitor
// alongside the trace hook.
//
// Shared decisions live in the sibling folders of ./hooks/:
//   - ./statement-analysis/   — predicates and classifiers (is this
//                                a leaf? should it be skipped?)
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
import { createForHeadDeclarationDetector } from '../../domain/code-hook-injector/service/statement-analysis/for-head-declaration-detector';
import { createEnclosingScopeLabeler } from '../../domain/code-hook-injector/service/meta-fields/enclosing-scope-labeler';
import { extractSource } from '../../domain/code-hook-injector/service/meta-fields/source-snippet-extractor';
import { extractLeadingComment } from '../../domain/code-hook-injector/service/meta-fields/leading-comment-extractor';
import { relFile } from '../../domain/code-hook-injector/service/meta-fields/relative-file-path';
import { createPlaywrightImportRewriter } from '../../domain/code-hook-injector/service/playwright-import-rewriter';
import { createGlobalTraceCallBuilder } from '../../domain/code-hook-injector/service/trace-hook/global-trace-call';
import { createEnterMetaLiteralBuilder } from '../../domain/code-hook-injector/service/trace-hook/enter-meta-literal';
import { createTryFinallyWrapperBuilder } from '../../domain/code-hook-injector/service/trace-hook/try-finally-wrapper';
import { createVariableDeclarationHoister } from '../../domain/code-hook-injector/service/trace-hook/variable-declaration-hoister';
import { HEAL_ENTER } from '../../domain/trace-event-recorder/model/global-names';

interface CodeHookInjectorOptions {
  include?: Include;
  rootDir?: string;
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

  const { isGeneratedModuleStatement } = createCjsArtifactDetector(t);
  const { isLeafStatement, kindOf, containsAwait } = createLeafStatementClassifier(t);
  const findScopeName = createEnclosingScopeLabeler(t);
  const isNonWrappableStatement = createNonWrappableStatementPredicate(
    t,
    isGeneratedModuleStatement,
  );
  const isForHeadDeclaration = createForHeadDeclarationDetector(t);
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

        if (t.isVariableDeclaration(node)) {
          // `const x = EXPR` can't be wrapped as-is — the binding
          // would be scoped to the try block and invisible downstream.
          // Hoist the bindings out, assign inside the try, pass a
          // vars object to __ok so the recorder can snapshot values.
          if (isForHeadDeclaration(node, stmtPath.parent)) return;

          const { hoistDecl, assignments, varsObject, bindingNames } =
            hoistVariableDeclaration(node);
          const okArgs = bindingNames.size ? [varsObject] : [];
          const { threwId, tryStmt } = buildTryFinally(stmtPath.scope, assignments, okArgs);

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

        const { threwId, tryStmt } = buildTryFinally(stmtPath.scope, [node]);
        const wrapper = t.blockStatement([
          callStmt(HEAL_ENTER, [meta]),
          buildThrewDecl(threwId),
          tryStmt,
        ]);

        stmtPath.replaceWith(wrapper);
      },
    },
  };
}

export = codeHookInjector;
