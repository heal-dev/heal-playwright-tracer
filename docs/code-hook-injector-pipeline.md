# How the code-hook injector works

## The one-sentence version

The code-hook injector runs as a Babel visitor during Playwright's
transform pipeline: it walks each test file's AST, rewrites the
`@playwright/test` import, and wraps every leaf statement in an
`__enter/__ok/__throw` try/catch/finally block (the **trace hook**).

Future custom-hook families will plug into the same Statement visitor
alongside the trace hook — the diagram below shows the trace-hook path
specifically, since that's the only hook family currently implemented.

## Pipeline diagram

```
┌────────────────────────────────────────────────────────────────────┐
│  Playwright test runner invokes Babel on tests/foo.test.ts         │
└──────────────────────────────┬─────────────────────────────────────┘
                               │
                               ▼
            ┌──────────────────────────────────────┐
            │  @babel/plugin-transform-modules-    │
            │  commonjs (runs FIRST, not us)       │
            │  import X from 'y'                   │
            │    → var _y = require('y')           │
            └──────────────────┬───────────────────┘
                               │
                               ▼
            ┌──────────────────────────────────────┐
            │      src/code-hook-injector.ts       │
            │        (our Babel plugin)            │
            └──────────────────┬───────────────────┘
                               │
          ┌────────────────────┴────────────────────┐
          ▼                                         ▼
  ╔══════════════════╗                   ╔══════════════════════╗
  ║  Program visitor ║                   ║  Statement visitor    ║
  ║  (runs once)     ║                   ║  (runs per node)      ║
  ╚════════╦═════════╝                   ╚══════════╦════════════╝
           │                                        │
           ▼                                        ▼
  matcher.buildMatcher              ┌───── matcher.buildMatcher
  (file in /tests/?)                │      (skip non-test files)
           │                        │
           ▼                        ▼
  Find ImportDeclaration      ast-predicates:
  from '@playwright/test'      • isGeneratedModuleStatement? ─ skip
           │                   • isLeafStatement?             ─ skip if no
  Rewrite .source to                   │
  'heal-playwright-tracer'             │
                                       ▼
                              ┌─── Is it a VariableDeclaration? ───┐
                              │                                    │
                              ▼                                    ▼
                     hoist `let x;` out                     wrap as block:
                     of try, assign inside                  { __enter; try {…} }
                              │                                    │
                              └─────────────┬──────────────────────┘
                                            │
                                            ▼
                              ╔════════════════════════════════╗
                              ║  hooks/trace-hook/ composes:   ║
                              ║  • enter-meta-literal          ║
                              ║     ├─ kindOf                  ║
                              ║     ├─ labelEnclosingScope     ║
                              ║     ├─ containsAwait           ║
                              ║     ├─ extractSource           ║
                              ║     └─ relFile                 ║
                              ║  • global-trace-call('__enter')║
                              ║  • try-finally-wrapper         ║
                              ║     ├─ catch→__throw+rethrow   ║
                              ║     └─ finally→__ok            ║
                              ║     + buildThrewDecl           ║
                              ╚══════════════╦═════════════════╝
                                            │
                                            ▼
                              path.replaceWith(wrapper)
                                            │
                                            ▼
                              (node tagged _traced=true so
                               visitor doesn't re-enter it)
```

## Per-statement transform

```
INPUT                                OUTPUT
─────                                ──────
const x = compute();      →          globalThis.__enter?.({file, line, scope, source, …});
                                     let x;                          // hoisted out of try
                                     let _traceThrew = false;
                                     try {
                                       x = compute();                // assignment only
                                     } catch (_traceErr) {
                                       _traceThrew = true;
                                       globalThis.__throw?.(_traceErr);
                                       throw _traceErr;
                                     } finally {
                                       if (!_traceThrew)
                                         globalThis.__ok?.({ x });   // snapshot binding
                                     }

foo();                    →          {
                                       globalThis.__enter?.({…, source: "foo();"});
                                       let _traceThrew = false;
                                       try {
                                         foo();
                                       } catch (_traceErr) {
                                         _traceThrew = true;
                                         globalThis.__throw?.(_traceErr);
                                         throw _traceErr;
                                       } finally {
                                         if (!_traceThrew) globalThis.__ok?.();
                                       }
                                     }
```

## At runtime

```
Instrumented code executes ──→ globalThis.__enter/__ok/__throw
                                         │
                                         ▼
                              src/trace-event-recorder/entrypoint.ts (default instance)
                              pushes events into MemorySink,
                              pairs enter↔ok/throw via an internal stack,
                              computes duration / cpu / heap deltas on pop
                                         │
                                         ▼
                              trace-output feature flushes
                              snapshot() to statement-trace.json
                              at fixture teardown
```

## Key design choices the diagram encodes

1. **Compound statements (`if`/`for`/`try`/…) are transparent** — the
   visitor skips them and only wraps their inner leaves, so we never
   have to track branch coverage or balance try blocks.
2. **`globalThis.__enter?.(…)` not bare `__enter(…)`** — survives
   `Function.prototype.toString()` shipping callbacks into a browser
   VM without the recorder. Istanbul hit the same issue and landed on
   the same solution.
3. **`VariableDeclaration` hoists `let x;` out of the try** — keeps
   `x` visible to later statements, still captures its value via
   `__ok({x})`.
4. **CJS-generated `var _x = require(…)` is skipped** — instrumenting
   it would call `__enter` before the recorder module has loaded.
5. **`_traced = true` marker** — prevents the visitor from recursing
   into its own generated wrapper.
