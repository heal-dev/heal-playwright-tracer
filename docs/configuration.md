# Configuration

End-user surface for `@heal-dev/heal-playwright-tracer`: the
reporter, how to register exporters and lifecycles, tune timeouts,
and consume the package from an ESM project. For the runtime
architecture and the internals of the screenshot pipeline see
[`architecture.md`](architecture.md).

## Reporter

The `HealTracerReporter` is **required** when the Babel plugin is
wired (see the [README](../README.md#install) for the minimal
config). It runs in the Playwright main process and handles three
things in-worker code can't:

1. **Crash rescue.** When a worker dies before the fixture can
   finalize its trace (OOM, SIGKILL, segfault, `process.exit()`),
   the per-test NDJSON is left without its `test-result`
   terminator. The reporter appends a synthesized `test-result`
   carrying the classified crash cause (e.g. `OutOfMemoryError`,
   `WorkerCrash`).
2. **Playwright artefacts.** Playwright populates
   `testInfo.attachments` (trace.zip, video, failure screenshots,
   user `testInfo.attach()` files) **after** our fixture's
   `afterEach` returns. The reporter is the first hook with the
   final attachment list, so it copies each artefact from
   Playwright's outputDir into the persistent
   `heal-traces/<executionId>/<playwrightTestId>/<attempt>/` tree
   and appends a `test-attachments` record to the NDJSON. This is
   what powers the `Trace` button and video pane in
   `heal-tracer view`.
3. **Execution history.** The reporter writes
   `heal-traces/<executionId>/execution.json` and appends one
   `ExecutionRecord` line to `heal-traces/executions.ndjson`,
   producing the run index the viewer's execution selector reads.

If you wire the Babel plugin without registering the reporter, the
fixture fails fast on the first test of every worker with a
diagnostic pointing back here. The reporter is idempotent — wiring
it more than once is safe.

## `configureTracer`

`configureTracer` registers extra exporters (fanned out alongside
the default NDJSON exporter), per-test setup/teardown pairs,
per-statement pre-processors, and optional timeout overrides:

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';
import { configureTracer } from '@heal-dev/heal-playwright-tracer';

configureTracer({
  exporters: [(ctx) => new MyHttpExporter(ctx.transport)],
  lifecycles: [
    () => ({
      setup: (ctx) => openTelemetrySession(ctx.testInfo),
      teardown: () => closeTelemetrySession(),
    }),
  ],
  preProcessors: [
    // Async hook fired BEFORE every traced leaf statement.
    // See "Pre-processors" below.
    async ({ meta, ctx }) => {
      if (meta.source.includes('[my-marker=')) {
        await stampMyMarkerOnPages(ctx.browserContext);
      }
    },
  ],
  timeouts: {
    screenshotMs: 10_000, // optional; see "Tuning timeouts" below
    lifecycleMs: 30_000,
  },
});

export default defineConfig({
  /* ... */
});
```

Full surface: [`src/application/heal-config/types.ts`](src/application/heal-config/types.ts).
Exporters implement [`HealTraceExporter`](src/domain/trace-event-recorder/port/heal-trace-exporter.ts)
(`write(record)` + `close()`).

## Pre-processors

A `StatementPreProcessor` is an async function the tracer awaits
**before** every traced leaf statement runs. It receives the same
`meta` object the recorder gets (`file`, `startLine`, `kind`,
`scope`, `source`, …) plus a context exposing the live
`browserContext`:

```ts
import type { StatementPreProcessor } from '@heal-dev/heal-playwright-tracer';

const myPreProcessor: StatementPreProcessor = async ({ meta, ctx }) => {
  // meta:        EnterMeta — the recorder's per-statement payload
  // ctx:         StatementPreProcessorContext
  // ctx.browserContext: the live Playwright BrowserContext for the test
  // ctx.testInfo, ctx.healDataDir, ctx.transport: same as exporter/lifecycle
};
```

### When to use one

Pre-processors are for side effects that must complete before
Playwright resolves the next locator or runs the next call. Typical
shapes:

- **DOM stamping** — write attributes onto the page so a
  custom-selector strategy embedded in the test source can resolve.
- **Eager telemetry** — push a span/event correlated with the
  upcoming statement (rare; an exporter is usually a better fit).
- **Page priming** — wait for an idle state, hydrate session
  storage, etc., when the test source matches a known pattern.

Example — a pre-processor that scans the upcoming statement's source
for a custom selector convention, and stamps a matching attribute on
the live DOM before Playwright resolves the locator:

```ts
import type { StatementPreProcessor } from '@heal-dev/heal-playwright-tracer';

const FOO_SELECTOR = /\[data-foo="([^"]+)"\]/;

export const fooStamper: StatementPreProcessor = async ({ meta, ctx }) => {
  const match = FOO_SELECTOR.exec(meta.source);
  if (!match) return;
  const value = match[1];
  for (const page of ctx.browserContext.pages()) {
    await page.evaluate(
      ({ value }) => {
        for (const el of document.querySelectorAll(`[data-bar="${value}"]`)) {
          el.setAttribute('data-foo', value);
        }
      },
      { value },
    );
  }
};
```

Registered as:

```ts
configureTracer({ preProcessors: [fooStamper] });
```

A statement like `await page.locator('[data-foo="abc"]').click()` then
finds the elements your stamper just decorated.

### Async-only

The Babel plugin emits `await globalThis.__heal_preprocess?.(meta)`
inside the try block of each leaf statement. That `await` is a syntax
error in synchronous functions, so the emit is **gated on the
enclosing function being `async`**:

- Statements inside `async` functions (test bodies, async helpers,
  async fixtures) → pre-processors run.
- Statements inside synchronous helpers → pre-processors are skipped
  silently. If you need pre-processing there, mark the helper
  `async`.

Playwright's `test()`, `test.beforeEach`, `test.afterEach`,
`test.beforeAll`, `test.afterAll`, and `test.step` callbacks are all
required to be async, so the typical test path is fully covered.

### Errors propagate

The pre-processor call lives inside the same try/catch that wraps
the user statement. A pre-processor that throws will:

1. Trigger `__heal_throw(err)` for the statement (so the trace shows
   the failure on the statement that triggered it).
2. Re-throw out of the wrapper, surfacing as a normal Playwright
   test error.

The user's statement does **not** run when a pre-processor throws.
If a partial side-effect is acceptable in your domain, defend
internally (try/catch + log + return) inside the pre-processor.

### Composition order

Multiple pre-processors run in **declaration order**, awaited
sequentially. A slow one delays every subsequent one for the same
statement. The fixture installs a single
`globalThis.__heal_preprocess` per test that loops over the
registered array — there is no parallelism.

```ts
configureTracer({
  preProcessors: [pp1, pp2, pp3],
  // For each traced leaf: await pp1 → await pp2 → await pp3 → user statement.
});
```

### What does NOT trigger pre-processors

- Statements inside files not matched by the Babel plugin's
  `include` filter.
- Module-level statements outside any function body.
- Imports, exports, function declarations, block statements, empty
  statements, CJS `require` artifacts (skipped by the
  non-wrappable-statement predicate — same set the trace hook itself
  ignores).
- Loop heads (`for (let i = 0; ...; ...)` — the binding can't be
  hoisted; the body is still instrumented per-statement).

## Tuning timeouts

Two optional knobs on `configureTracer({ timeouts })`:

```ts
configureTracer({
  timeouts: {
    screenshotMs: 10_000, // default — caps screenshot decoration calls
    lifecycleMs: 30_000, // default — caps user setup/teardown and projector.finalize
  },
});
```

- `screenshotMs` covers everything described in the screenshot-pipeline
  section of [`architecture.md`](architecture.md#decoration-timeouts-screenshotms)
  (`boundingBox`, `locator.evaluate`, every CDP send, `newCDPSession`,
  `page.screenshot`, overlay `page.evaluate`, action-path
  `scrollIntoViewIfNeeded`). On timeout the screenshot is dropped
  silently and the action proceeds — capture is best-effort.
- `lifecycleMs` covers each `lifecycle.setup` / `lifecycle.teardown`
  pair, the drained `onTestTeardown` hook chain, and the final
  `projector.finalize` (which closes every registered exporter). On
  timeout the fixture logs to stderr and continues with the next
  teardown step — the test result is preserved even if a
  user-registered exporter's `close()` hangs.

Both fields are optional; omit the `timeouts` block entirely to keep
the defaults.

## Why CommonJS?

The package ships as CommonJS (no `"type": "module"` in
`package.json`, `tsc` emits `module: commonjs`). This is deliberate:
Playwright's babel transform — the thing that actually loads
`code-hook-injector` — is itself a CJS module and consumes the plugin
via `require()`. Shipping ESM would force a dual build with no upside.

ESM consumers still work — use `createRequire` in
`playwright.config.ts` if you need to resolve the plugin path:

```ts
// playwright.config.ts  (package.json has "type": "module")
import { defineConfig } from '@playwright/test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export default defineConfig({
  // @ts-ignore
  '@playwright/test': {
    babelPlugins: [[require.resolve('@heal-dev/heal-playwright-tracer/code-hook-injector')]],
  },
});
```

> **The module format of `playwright.config.ts` must match the
> `"type"` field of its nearest `package.json`.** A mismatch causes
> Node to route the file through the wrong loader, typically surfacing
> as `ReferenceError: exports is not defined in ES module scope` —
> with a stack trace that blames this plugin even though it has never
> run. If that happens, fix the config format first.

## Debug logging

The tracer uses a unified two-level logger that writes to stderr
with a consistent prefix so users can grep one or the other:

```
[heal-playwright-tracer] [error] <message>
[heal-playwright-tracer] [warn] <message>
```

- **`[error]`** — real failures the user should see by default
  (lifecycle setup rejections, projector.finalize timeouts,
  reporter file-write failures, exporter-factory throws). Always
  written to stderr.
- **`[warn]`** — best-effort failures the tracer recovered from
  (scroll throws, boundingBox null, overlay-cleanup catches,
  screenshot capture rejects). **Silent unless `HEAL_DEBUG=1`** —
  without the env var these are noise; with it, they're a
  diagnostic for "why did the tracer behave this way on this
  page."

```sh
HEAL_DEBUG=1 npx playwright test 2>&1 | grep '\[warn\]'   # see only warnings
HEAL_DEBUG=1 npx playwright test 2>&1 | grep '\[error\]'  # see only errors (always available)
```

Common scenarios surfaced by `HEAL_DEBUG=1`:

- `scrollIntoViewIfNeeded failed before <action> screenshot` —
  the pre-screenshot scroll didn't settle within `screenshotMs`.
  Capture proceeds with the un-scrolled state; the user's action
  still gets the full `actionTimeout` to scroll and act.
- `measureBox boundingBox threw — skipping highlight overlay` —
  target detached or page navigated before we could measure.
- `drawOverlay threw — skipping highlight screenshot` — the
  page-side overlay injection failed (typically because the page
  navigated mid-flight).
- `takeScreenshot threw after overlay was drawn` — the screenshot
  call itself rejected (CDP timeout, page closed). Cleanup still
  removes the overlay.
- `newCDPSession failed; falling back to page.screenshot for this
page` — one-time per page when CDP isn't available
  (Firefox/WebKit). Capture continues via Playwright's own
  `page.screenshot`.
- `overlay cleanup rejected after locator.<action>` — page
  navigated/closed while we were trying to remove the overlay.

## Print per-test artifact paths

Set `HEAL_PRINT_ARTIFACT_PATHS=1` to print the test's output
directory to stderr after each test. That directory contains every
artifact Playwright and this tracer produce for the test — the
nested `heal-data/` folder with the ndjson + highlight screenshots,
plus Playwright's own `trace.zip` and videos:

```sh
HEAL_PRINT_ARTIFACT_PATHS=1 npx playwright test
```

```
[heal-playwright-tracer] my test (passed)
  test artifacts dir: /path/to/test-results/foo
```
