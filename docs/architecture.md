# Architecture

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

## Locator-action highlight screenshots

Every patched locator action (and locator-targeted assertion) takes a
highlight screenshot before the action runs. The pipeline is one
unified flow on every browser:

1. **(Optional) scroll the target into view.** Locator actions
   always scroll — Playwright's own actionability would scroll
   anyway, so we do it a few ms earlier so the screenshot matches
   what the action will see. Locator assertions also scroll, with
   one carve-out: `toBeInViewport()` / `not.toBeInViewport()`,
   whose outcome depends on viewport position, opt out of the
   pre-screenshot scroll in `assertion-wrapper.ts`. Every other
   assertion (`toBeVisible`, `toHaveText`, …) is viewport-position
   independent, so scrolling is safe.
2. **Measure the target's bounding box** via `locator.boundingBox()`.
3. **Inject a `<div>` overlay** at the target's document position —
   a 4px magenta border with a faint translucent fill
   (`rgba(255, 0, 255, 0.08)`), drawn page-side via
   `overlay-helpers.ts`. We use a `<div>` rather than a `<canvas>`
   because Playwright's trace viewer captures DOM snapshots: an
   empty `<canvas>` is a replaced element whose default bitmap is
   transparent, which the trace viewer renders as a checkerboard
   placeholder masking the page content underneath.
4. **Capture a viewport screenshot.** On Chromium we go through
   CDP `Page.captureScreenshot { format: 'png' }` directly —
   `page.screenshot()` would force the configured viewport via
   `Emulation.setDeviceMetricsOverride` and visibly resize the OS
   window in headed mode. On Firefox / WebKit (no CDP) we fall
   back to `page.screenshot({ path, timeout })`.
5. **Return a cleanup closure** that removes the `<div>` after the
   caller's action / assertion completes.

CDP `Overlay.highlightNode` is **not** used. It paints box-model
regions with colors and has no native "outline around the element"
mode, so the highlight is invisible at our chosen translucent
alpha on elements without a CSS border. Going through the `<div>`
overlay produces a visible frame on every browser without caring
about the element's CSS.

### Known limitation: layout-shift staleness

`boundingBox()` does not wait for actionability / stability the
way Playwright's actions do, so on pages with late layout shifts
(lazy images, font swaps, deferred hydration above the target)
the captured coords can be stale by the time the screenshot is
taken — the box ends up framing empty space where the element
used to be. The pre-screenshot scroll mitigates this by waiting
for the target to settle into view, but doesn't eliminate it.

### `scrollIntoViewIfNeeded` is not patched

`scrollIntoViewIfNeeded` is intentionally **not** in the
patched-actions list (`HIGHLIGHTED_LOCATOR_ACTIONS` in
`locator-patch.ts`). Patching it would cause infinite recursion
when our own pre-screenshot scroll re-entered the patched method,
and the standalone scroll-screenshot is redundant given every
other action now scrolls-then-screenshots anyway.

### Decoration timeouts (`screenshotMs`)

Every async the session awaits is capped at 10 seconds:
`scrollIntoViewIfNeeded`, `boundingBox`, the overlay's
`page.evaluate` (draw / remove), the CDP `Page.captureScreenshot`
send, `newCDPSession`, and the `page.screenshot` fallback. Without
these caps, Playwright auto-waits the locator-resolution calls for
the full configured `actionTimeout`, and CDP itself has no
protocol-level timeout — a wedged renderer (alert dialog, JS
deadlock, hung navigation) could otherwise let screenshot
decoration outlast the action it is decorating. Decoration must
always fail-fast so the test fails on the user's actual action,
not on the tracer's overlay.

Capture is best-effort: if any of these caps fires the rejection
is silently swallowed, the screenshot is dropped (or, for the
pre-screenshot scroll, the un-scrolled state is captured), any
partially-drawn overlay is still cleaned up via the cleanup
closure, and the original action proceeds normally. The
pre-screenshot `scrollIntoViewIfNeeded` is wrapped in its own
`try`/`catch` — a slow page that doesn't settle within
`screenshotMs` produces a viewport-only screenshot of wherever
the page currently is, rather than failing the test. Playwright's
own actionability check then runs again as part of the user's
action and gets the full project `actionTimeout` to scroll and
act, so a transient slowness in our pre-screenshot scroll never
turns into a test failure.

The cap value is configurable — see [`configuration.md`](configuration.md).

### Visual regression test

`tests/integration/specs/screenshot-visual.test.ts` covers the pipeline
end-to-end on real Chromium: one sandbox runs a 6-case Playwright
spec (action click and assertions, in/off-viewport, plus the
`toBeInViewport` carve-out) and the test then walks the produced
`heal-traces/.../screenshots/*.png` and asserts the magenta overlay
landed at the expected viewport coordinates. Region-based pixel
sampling, no byte-equal baselines — see the file header for the
case table.

To eyeball the captures locally:

```sh
npm run test:integration:visual:dump
open tmp/visual-dumps/   # one PNG per case, slugified by test title
```

The dump runs unconditionally before assertions, so a failing case
still leaves its PNG behind. Set `HEAL_VISUAL_DUMP_DIR=<path>`
explicitly to dump elsewhere.

## On-disk layout

Per (test, attempt), the tracer produces:

```
heal-traces/<executionId>/<playwrightTestId>/<attempt>/
├── heal-traces.ndjson     ← always present (statement stream)
├── heal-network.ndjson    ← only when `network.enabled`
├── heal-console.ndjson    ← only when `console.enabled`
├── trace.zip              ← copied by the reporter from Playwright's outputDir
├── screenshots/           ← locator-action highlight PNGs
└── videos/                ← Playwright videos copied in by the reporter
```

`heal-traces.ndjson` is the canonical timeline: `test-header`,
zero or more `statement` records, exactly one `test-result`, and an
optional `test-attachments` appended by the reporter.

The two sidecars live next to it because the streams have different
write patterns. The statement stream is single-writer, append-only,
and produced by a deterministic projector. Network and console
events fire at any time across every page the test owns, including
popups and api-request contexts; mixing them into the statement file
would force the projector to merge unrelated streams and would make
crash recovery harder. Splitting also lets retention rules differ —
keeping the statement stream forever while dropping network bodies
on green tests, for instance.

Cross-link is by `t` (ms since `Statement.startedAt`, identical
clock origin) and an optional `statementSeq` snapshot of the
top-of-enter-stack at emit time. The viewer interleaves the streams
on a single timeline without joining records.

## Schema versioning

`HEAL_TRACE_SCHEMA_VERSION` (in
[`statement-trace-schema.ts`](../src/domain/trace-event-recorder/model/statement-trace-schema.ts))
is bumped whenever a backwards-incompatible change lands in the main
NDJSON contract — adding a new record `kind` counts. The version
appears on every `test-header` so consumers can branch on it.
`SCHEMA_VERSION` (raw recorder events in
[`trace-schema.ts`](../src/domain/trace-event-recorder/model/trace-schema.ts))
is independent: it tracks the in-process event stream the projector
folds into records, and only bumps when an event variant changes.
