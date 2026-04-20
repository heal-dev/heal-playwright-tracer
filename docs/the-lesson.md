# The lesson worth taking away

**If you're about to extend `src/code-hook-injector.ts`, stop and read
[`istanbul-lib-instrument/src/visitor.js`](https://github.com/istanbuljs/istanbuljs/blob/main/packages/istanbul-lib-instrument/src/visitor.js)
first.** It's the single best reference in the JS ecosystem for "how do
I instrument every corner of modern JavaScript without breaking
something," and every edge case you're going to hit is already handled
there, correctly, by people who've been iterating on this problem since 2012.

## Why we don't _use_ Istanbul directly

`heal-playwright-tracer` and Istanbul use **the same fundamental
technique** — a Babel plugin that walks the AST of each file, inserts
extra code around statements, and emits the modified source for the
runtime to execute. The plugin surface (`@babel/traverse`,
`@babel/types`, the visitor pattern, plugin options) is identical.

The difference is in _what we record_, and that's where the two tools
diverge:

|                       | Istanbul                                                            | heal-playwright-tracer                                                                             |
| --------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Question it answers   | "Did this line run, and how many times?"                            | "What happened during this test — when, how long, with what values, why did it throw?"             |
| Per-statement cost    | One integer increment (`counter.s[0]++`)                            | `try/catch/finally` wrapper + object allocation + performance.now + process.cpuUsage + heap sample |
| Data model            | Static location maps + dynamic counters (two parts per file)        | Time-ordered event stream (one part per run)                                                       |
| Branch coverage       | Yes — tracks both arms of `if`, `&&`, `??`, switch cases, ternaries | No — compound statements are transparent to the tracer                                             |
| Function entry counts | Dedicated counter                                                   | Inferred from any enter event inside the function body                                             |
| Merge across runs     | Commutative: two reports add with `+`                               | Two event streams don't compose cleanly                                                            |
| Timing                | Not captured                                                        | Per-statement duration, CPU, event-loop lag                                                        |
| Error flow            | Not captured                                                        | `throw` events with full stack + cause chain                                                       |
| Variable values       | Never inspected                                                     | Serialized on `ok` for variable declarations                                                       |
| Async call tree       | Not modeled                                                         | Modeled via an active-enter stack (correct for sequential code)                                    |
| Locator screenshots   | Unaware                                                             | Highlight PNG captured around every patched Locator action, filename stamped onto the statement    |
| Overhead              | ~1–5% runtime slowdown                                              | Probably 5–20% — not yet measured                                                                  |

In short: **Istanbul is an aggregator, we are a recorder.**

Coverage tools throw away timing, error flow, variable state, and call
order because none of it helps answer _"did line 42 run?"_. We need all
four of those to help the autopilot agent understand _why_ a test went
wrong, so we had to build the event-stream shape. But we did not need
to re-derive how to identify a leaf statement, how to hoist `const`
bindings out of a try block, how to handle destructuring patterns, how
to skip for-loop init positions, how to avoid double-instrumenting
transformed imports — all of that is in `istanbul-lib-instrument`,
and you can read it as a proven-correct reference.

## When you'll need this

The edge cases we haven't exercised yet but that Istanbul handles
routinely:

- **Arrow functions with expression bodies** — `x => x + 1` has no
  statement to instrument; Istanbul rewrites to `x => { return x + 1 }`
  before inserting its counter. We currently do nothing for this case.
- **JSX / TSX** — JSX elements aren't statements but their embedded
  expressions can be. Istanbul's visitor handles JSX fragments,
  attributes, spread children.
- **Class fields and static blocks** — instance initializers and static
  blocks run at interesting times. Neither is currently instrumented by
  our plugin.
- **Decorators** — stage-3 and legacy. Istanbul handles both.
- **Logical assignment operators** — `a ??= b`, `a ||= b`, `a &&= b`.
  Istanbul tracks branch coverage on each. We ignore them.
- **Optional chaining branches** — `a?.b.c` is two branches.
- **Generators and async generators** — `yield` suspension interacts
  with try/finally in subtle ways. Istanbul tested this on real
  generator code; we haven't.
- **Property initializers inside object literals** — `{ get foo() {} }`,
  `{ set foo(v) {} }`, computed keys.
- **Tagged template literals and template element holes.**

When we bump into one of these and our plugin produces broken or
unreadable output, the answer will almost always be: _"open
`istanbul-lib-instrument/src/visitor.js`, find the matching case,
adapt it to emit `__enter`/`__ok`/`__throw` instead of counter
increments."_

## And if we ever want pure coverage too

The other tool in the JS coverage world is [`c8`](https://github.com/bcoe/c8),
which is conceptually different again. `c8` doesn't rewrite source —
it asks V8 itself for coverage data via the Chrome DevTools Inspector
protocol (`Profiler.startPreciseCoverage`). Zero overhead, works on
any input including dynamic `eval`, but V8-only and coarser-grained.

If we ever want "plain coverage, as a side product" on top of our own
tracer, the cheapest path is to run `c8` alongside us — it won't
conflict because it doesn't touch the source. The more ambitious path
is to ship a mini reporter that aggregates our event stream into an
Istanbul-shaped coverage object, which the standard Istanbul reporters
can then render. Both are future work.

## Known drawbacks of the current implementation

Living list of things we accept today but may want to revisit.

### Correctness / semantics

1. **⚠ Async call-tree corrupts under concurrency.** The runtime
   maintains a single global stack. Two async chains running
   concurrently (`Promise.all([a(), b()])`, background event handlers,
   `setInterval`) will interleave pushes/pops on that same stack, so
   `parentSeq` stops being meaningful. Fix: use `AsyncLocalStorage` or
   `async_hooks` to keep a per-async-context stack. Non-trivial.

2. **⚠ `const` → `let` hoisting loses the TDZ check.** Runtime behavior
   is identical for normal code; the pathological `const x = (() => x)()`
   becomes `undefined` instead of throwing a TDZ `ReferenceError`. No
   real test hits this.

3. **Return/break/continue record as `type: 'ok'`.** The finally block
   pops the stack so balance is correct, but consumers can't tell from
   the event type whether the statement finished normally or jumped out.

4. **Catch branch swallows and rethrows.** V8 preserves the original
   stack, but each wrapped statement adds a synthetic frame to
   `error.stack`. Source maps help; raw stacks are fatter.

5. **Direct `eval()` is a black hole.** We instrument the call site but
   the evaluated source is never seen by the plugin.

6. **Generators / async generators are untested.** Interactions with
   `.throw()` / `.return()` may not do what you expect.

### Coverage gaps

7. **Compound statements not instrumented.** We drop `if` / `for` /
   `while` / `switch` / `try` entirely — their inner statements still
   get enter events but the compound itself does not. Lets us keep the
   stack balanced without branch tracking, at the cost of "did the
   condition hit?" visibility.

8. **Variable snapshots only for declarations.** `const x = f()`
   captures `x`. A plain `doThing(y)` doesn't record `y`.

9. **`hasAwait` is local only.** Checks the direct AST of the statement,
   not transitive calls.

### Performance

10. **Per-statement overhead.** Each statement allocates an event
    object, pushes an array entry, reads `performance.now()`,
    `process.cpuUsage()`, `loopMonitor.max`, `process.memoryUsage()`,
    and is wrapped in try/catch/finally. Unmeasured but probably 5–20%
    slowdown for statement-dense test loops. Acceptable for end-to-end
    tests, expensive for anything benchmark-adjacent.

11. **Compiled code size explodes.** A 100-line test file becomes
    ~1500 lines after instrumentation. V8's parser + Ignition pay for
    that on every worker cold-start.

12. **Screenshot pipeline is the biggest wall-clock cost.** Each
    highlighted locator action blocks on
    `locator.highlight()` + `page.screenshot()` before the real action
    runs. ~100–300 ms per click/fill.

13. **Trace buffer is unbounded.** No streaming, no cap. A 10,000-
    statement test holds 30,000+ event objects until teardown.

### Playwright integration risks

14. **⚠ Everything depends on private API:**
    - `defineConfig({ '@playwright/test': { babelPlugins: [...] } })` —
      not in the public types.
    - `page._instrumentation.addListener({ onApiCallBegin, onApiCallEnd })` —
      leading underscore means "don't touch."
    - Playwright's Babel transform pipeline's plugin slot
      (`pluginsPrologue`).

    Any of these can disappear in a Playwright minor version with zero
    warning. Keep an eye on the release notes when upgrading
    `@playwright/test`.

15. **Cache keyed on plugin path, not content.** Editing the plugin
    doesn't invalidate Playwright's transform cache. Manual fix:
    `rm -rf /var/folders/*/T/playwright-transform-cache-*`.

16. **`Locator.prototype` is monkey-patched process-wide.** No opt-out
    for a specific test. Tests that measure click timing get the
    screenshot cost added to their timings. Global env var disables it:
    `HEAL_TRACE_SCREENSHOTS=0`.

17. **Fixture auto-depends on `page`.** Every test — even a pure-JS
    one — pays the browser startup cost.

18. **`test.step` monkey-patch is load-order-sensitive.** If a test
    file imports `test` from `@playwright/test` directly (bypassing our
    fixtures), the step stack isn't populated for that file.

### Metadata fidelity

19. **`findScopeName` is a heuristic.** Picks the innermost named
    function or test-framework call title. `foo(() => bar(() => stmt))`
    gives `"<anonymous>"`. Nested `describe` titles aren't composed.
    Renamed imports (`import { test as t }`) are missed.

20. **Relative paths assume `process.cwd()` is the repo root.** If
    tests are launched from a subdirectory, the `file` field is wrong.
    Override via the `rootDir` plugin option.

21. **Git SHA captured once per process.** Mid-run branch switch won't
    be reflected.

### Maintenance / dev-ex

22. **No unit tests for the plugin itself.** Integration coverage via
    Playwright tests is good, but `kindOf`, `findScopeName`,
    `containsAwait`, `isRequireLike`, `isGeneratedModuleStatement` have
    no direct tests. Refactoring is scary.

23. **Debugging instrumented code is noisy.** Source maps point at the
    original line but stepping through the generated
    try/catch/finally/if in a JS debugger is unpleasant.

24. **No schema migration strategy.** `schemaVersion: 1` is stamped on
    every trace but no code path reads older traces; bumping the
    version silently orphans existing files.

## The three fixes I'd pick first

If you're sitting down to improve this and can only do three things:

1. **Async-context-aware stack (#1).** The only limitation that can
   produce a silently wrong call tree. Everything else is either known
   noise or acceptable tradeoff.
2. **Content-hashed cache invalidation (#15).** Ten-line change, kills
   a daily dev-ex papercut.
3. **Make the `page` auto-dependency optional (#17).** Simple fixture
   refactor, removes a multi-second penalty from every non-browser
   test.
