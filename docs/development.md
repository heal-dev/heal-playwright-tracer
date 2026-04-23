# Development

## How it works

```
  Build time (per worker)                        Runtime (per test)
  ───────────────────────                        ──────────────────

  test file                                      instrumented test
      │                                                 │
      ▼                                                 ▼
  ┌───────────────────┐                         ┌────────────────┐
  │  Babel plugin     │  ─── instrumented ───►  │  recorder      │
  │  code-hook-       │      (__enter /         │  enter/ok/     │
  │  injector         │       __ok / __throw)   │  throw stream  │
  └───────────────────┘                         └────────┬───────┘
                                                         │
                                                         ▼
                                                 ┌────────────────┐
                                                 │  statement     │
                                                 │  projector     │
                                                 └────────┬───────┘
                                                          │
                                                          ▼
   playwright.config.ts                           ┌──────────────────┐
   configureTracer({      ─── extends ──────────► │    composite     │
     exporters,                                   │     exporter     │
     lifecycles,                                  └───┬──────────┬───┘
   })                                                 │          │
                                                      ▼          ▼
                                                   NDJSON     custom
                                                    file     exporters
                                                           (HTTP, queue, …)
```

The Babel plugin wraps every leaf statement with a try/catch/finally
that calls three runtime hooks. The recorder pairs those calls into an
event stream, the projector folds them into `HealTraceRecord`s, and
a composite exporter fans them out to the default NDJSON file and
any exporters registered via `configureTracer`.

The plugin also rewrites `from '@playwright/test'` to
`from '@heal-dev/heal-playwright-tracer'` in every instrumented file,
so `test` and `expect` automatically resolve to the traced variants —
no manual import swap required.

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

### Extend: custom exporters and lifecycles

`configureTracer` registers extra exporters (fanned out alongside
the default NDJSON exporter) and per-test setup/teardown pairs —
useful for shipping traces to your own backend or installing
per-test globals:

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
});

export default defineConfig({
  /* ... */
});
```

Full surface: [`src/application/heal-config/types.ts`](src/application/heal-config/types.ts).
Exporters implement [`HealTraceExporter`](src/domain/trace-event-recorder/port/heal-trace-exporter.ts)
(`write(record)` + `close()`).

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
