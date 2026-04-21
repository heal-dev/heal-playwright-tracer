<h1 align="center">
  <a href="https://heal.dev/">
    <img width="240" src="assets/heal-logo.svg" alt="heal">
  </a>
</h1>
<p align="center">
  <p align="center">Statement-level execution tracing for Playwright tests, purpose-built for AI autopilots.</p>
</p>

<h4 align="center">
  <a href="https://app.heal.dev/">SaaS</a> |
  <a href="https://heal.dev/">Website</a> |
  <a href="https://docs.heal.dev/">Docs</a>
</h4>

<h4 align="center">
  <a href="https://github.com/heal-dev/heal-playwright-tracer/actions/workflows/ci.yml"><img src="https://github.com/heal-dev/heal-playwright-tracer/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://codecov.io/gh/heal-dev/heal-playwright-tracer"><img src="https://codecov.io/gh/heal-dev/heal-playwright-tracer/branch/main/graph/badge.svg" alt="codecov"></a>
  <a href="https://www.npmjs.com/package/@heal-dev/heal-playwright-tracer"><img src="https://img.shields.io/npm/v/@heal-dev/heal-playwright-tracer.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@heal-dev/heal-playwright-tracer"><img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg" alt="node"></a>
  <a href="https://www.npmjs.com/package/@playwright/test"><img src="https://img.shields.io/badge/%40playwright%2Ftest-%3E%3D1.50.0-blue.svg" alt="playwright"></a>
</h4>

# @heal-dev/heal-playwright-tracer

An AI-agent-first diagnostic layer for Playwright tests. Purpose-built
to give an agent everything it needs to reason about _why_
a test failed: statement-level execution traces with timing,
variable values, call depth, serialized errors, highlighted locator
screenshots, and Playwright API correlations. Events are emitted as a
structured NDJSON stream per test, alongside Playwright's own HTML
report and trace viewer. Useful to humans too, but every design
decision optimizes for what an LLM needs to see.

## Install

```sh
npm install -D @heal-dev/heal-playwright-tracer
```

Wire the Babel plugin in `playwright.config.ts`.

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  // @ts-ignore — `babelPlugins` is a supported Playwright option not yet in its public types
  '@playwright/test': {
    babelPlugins: [
      [
        require.resolve('@heal-dev/heal-playwright-tracer/code-hook-injector'),
        { include: [/\/tests\//] },
      ],
    ],
  },
});
```

Or, if you prefer to keep the config fully typed, declare the
option once at the top of the file instead of using `@ts-ignore`:

```ts
declare module '@playwright/test' {
  interface Config {
    '@playwright/test'?: {
      babelPlugins?: Array<[string, object?]>;
    };
  }
}
```

Per-test output lands at
`test-results/<test>/heal-data/heal-traces.ndjson`.

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

## Sample output

`heal-data/heal-traces.ndjson` — one record per line:

```ndjson
{"kind":"test-header","schemaVersion":1,"test":{"title":"it works","file":"tests/example.spec.ts","context":{"testId":"...","attempt":1}}}
{"kind":"statement","statement":{"loc":{"line":5},"source":"await page.goto('https://example.com')","durationMs":412,"status":"ok","children":[...]}}
{"kind":"statement","statement":{"loc":{"line":6},"source":"await expect(page.getByRole('heading')).toBeVisible()","durationMs":73,"status":"ok"}}
{"kind":"test-result","status":"passed","duration":1234,"stdout":"...","stderr":""}
```

Schema: [`src/domain/trace-event-recorder/model/statement-trace-schema.ts`](src/domain/trace-event-recorder/model/statement-trace-schema.ts)
(also exported as `@heal-dev/heal-playwright-tracer/statement-trace-schema`).

### Screenshots

Every statement that calls a patched Playwright **locator action**
(`click`, `fill`, `hover`, `press`, …) or a **locator assertion**
(`expect(locator).toBeVisible()`, `toHaveText()`, …) produces a
PNG screenshot with the targeted element outlined via an overlay
drawn in-page — so the agent sees _what Playwright was actually
pointing at_ at the moment the action ran, not just the raw page.

Files are written to the per-test `heal-data/` directory and
referenced on the corresponding statement via the `screenshot`
field:

```ndjson
{"kind":"statement","statement":{"source":"await page.getByRole('button', { name: 'Submit' }).click()","status":"ok","screenshot":"stmt-0007.png"}}
{"kind":"statement","statement":{"source":"await expect(page.getByRole('alert')).toBeVisible()","status":"ok","screenshot":"stmt-0008.png"}}
```

Statements that don't touch a locator (plain JS, utility calls,
`page.goto`) have no `screenshot` field — capture is scoped to the
Playwright surface where it adds diagnostic signal.

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

## Caveats

The Babel plugin rewrites every leaf statement with a `try/catch/finally`
and three hook calls — the same shape of transformation Istanbul applies
for code coverage. Two consequences to be aware of:

- **Instrumented files are larger.** Each statement gains a wrapper, so
  on-disk size of transformed test files grows noticeably (typically
  ~2–4×, depending on statement density). This affects the files
  Playwright loads into workers, not your application bundle.
- **Tests run slightly slower.** The per-statement hook overhead is
  small in absolute terms but not free — expect a modest slowdown on
  CPU-bound test code. I/O-bound tests (the common case: `await
page.click(...)`, network, navigation) are dominated by the browser
  and barely move.

Scope the `include` filter in `playwright.config.ts` so only your
`tests/` directory is instrumented — never your app code or
`node_modules` — to keep the cost contained.

## License

Copyright © 2026 **MYIA SAS**.

This project is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**.
See the [LICENSE](LICENSE) file for the full text.
