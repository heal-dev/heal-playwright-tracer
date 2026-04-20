# @heal-dev/heal-playwright-tracer

Statement-level execution tracer for Playwright tests. Records every
executed line with timing, variable values, call depth, errors, and
Playwright API correlations — emitted as an NDJSON event stream per
test.

## What it ships

- **Babel plugin** (`./code-hook-injector`) — wraps every leaf
  statement in an `__enter / __ok / __throw` try/catch/finally block.
- **Runtime recorder** (`./trace-event-recorder`) — pairs enter/ok/
  throw into an event stream via an active-enter stack, serializes
  errors, snapshots variable bindings.
- **Playwright auto-fixture** (default export) — composes the
  recorder with `test.step` tracking, Playwright locator screenshots,
  stdout/stderr capture, and test correlation IDs.
- **NDJSON trace output** — writes one `HealTraceRecord` per line to
  `heal-data/heal-traces.ndjson` under `testInfo.outputDir`.

## Install

```sh
npm install -D @heal-dev/heal-playwright-tracer
```

## Wire up

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  ...({
    '@playwright/test': {
      babelPlugins: [
        [require.resolve('@heal-dev/heal-playwright-tracer/code-hook-injector'), { include: [/\/tests\//] }],
      ],
    },
  } as any),
});
```

```ts
// In test files — drop-in replacement for `@playwright/test`.
import { test, expect } from '@heal-dev/heal-playwright-tracer';

test('it works', async ({ page }) => {
  await page.goto('https://example.com');
  await expect(page.getByRole('heading')).toBeVisible();
});
```

Per-test output lands at
`test-results/<test>/heal-data/heal-traces.ndjson`.

## Output schema

See `docs/streaming-and-agent.md` for the wire format and
`src/features/trace-output/statement-trace-schema.ts` for the exact
types (also exported via `@heal-dev/heal-playwright-tracer/statement-trace-schema`).

## Docs

- `docs/code-hook-injector-pipeline.md` — how the Babel plugin works.
- `docs/trace-event-recorder-pipeline.md` — the runtime recorder and active-enter stack.
- `docs/streaming-and-agent.md` — NDJSON output, env toggles.
- `docs/the-lesson.md` — design notes, known limitations, Istanbul comparison.
- `docs/esm-and-commonjs.md` — module-system notes.
