<h1 align="center">
  <a href="https://heal.dev/">
    <img width="240" src="assets/heal-logo.svg" alt="heal">
  </a>
</h1>
<p align="center">
  <p align="center">Open-source statement-level Playwright tracer, purpose-built for AI agents.</p>
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

heal-playwright-tracer is an agent-first diagnostic layer for your Playwright tests. It gives agents
(and humans) everything they need to quickly analyze test results.

👉 **Add this to your playwright config, run your tests, point Claude to the heal tests, get more accurate test diagnosis**

## Why

The playwright trace doesn't contain enough data for LLM-based agents such as Claude or Open Code to analyze tests results reliably.
That's because the trace ifs focused on locator evaluation, while real-life tests also evaluate non-playwright code.
Heal adds the missing instrumentation layer to let LLM agents work their magic.
And it's useful for humans in complex test codebases, too!

| Feature        | Playwright Trace      | Heal Tracer          | Example: What Heal Adds                                                                   |
| -------------- | --------------------- | -------------------- | ----------------------------------------------------------------------------------------- |
| Granularity    | Action-level          | Statement-level      | Shows `let x = calculate()` line-by-line, not just the final `page.click()`.              |
| Data Format    | ZIP/Binary            | NDJSON Stream        | `{"type":"step","file":"auth.spec.ts","line":12,"val":{"user":"dev"}}`                    |
| Visual Context | Standard screenshots  | Highlighted locators | An image where the target button is outlined in a neon overlay to prove hit-box accuracy. |
| Variable State | Limited/Debugger only | Full Variable Values | Captures that `status_code` was `403` inside a hidden helper function.                    |
| Error Detail   | Standard stack trace  | Serialized Errors    | A JSON object containing the DOM snapshot at the exact millisecond of the throw.          |
| Timing         | Action durations      | Per-statement timing | Identifies that a specific `if` statement logic took `2.5s` to evaluate.                  |
| Correlations   | Loose logs/network    | API Correlations     | Links `Trace_ID_99` directly to `Source_Line_45` in the NDJSON stream.                    |

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

## Usage

1. After installing Heal, run your tests with the usual `npx playwright test` command.
2. You should see `heal-traces.ndjson`.
3. You can ask Claude or another agent to use those to understand your test results.

### Claude Skill

See [docs/SKILL.md] for a ready-made Claude skill that you can use.

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

## Architecture, and extending the tracer

See [development.md](docs/development.md)

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
