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
the default NDJSON exporter), per-test setup/teardown pairs, and
optional timeout overrides:

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
