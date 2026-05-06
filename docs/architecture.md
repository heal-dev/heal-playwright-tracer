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
highlight screenshot before the action runs. How the highlight is
drawn depends on the browser:

- **Chromium**: drawn natively via CDP `Overlay.highlightNode`. The
  renderer composes the highlight at rasterize time using the
  element's _current_ layout box, so the highlight cannot drift if
  the page reflows between locator resolution and screenshot.
  `Overlay.highlightNode` is a fill-based primitive (no native
  outline mode), so we keep the alpha very low
  (`contentColor: rgba(255, 0, 255, 0.08)`) — the visible highlight
  reads as a frame, not a tint, while still preserving rasterize-time
  composition.
- **Firefox / WebKit**: no CDP, so we fall back to a JS DOM overlay
  (`overlay-helpers.ts`) — a `<div>` with the same near-invisible
  magenta fill (`rgba(255, 0, 255, 0.08)`) and a 4px magenta border,
  matching
  the CDP path visually. We use a `<div>` rather than a `<canvas>`
  because Playwright's trace viewer captures DOM snapshots: an empty
  `<canvas>` is a replaced element whose default bitmap is
  transparent, which the trace viewer renders as a checkerboard
  placeholder masking the page content underneath. A `<div>`
  composes like any other transparent box. Coordinates come from
  `locator.boundingBox()`. `boundingBox()` does not wait for
  actionability/stability the way Playwright's actions do, so on
  pages with late layout shifts (lazy images, font swaps, deferred
  hydration above the target) the captured coords can be stale by
  the time the screenshot is taken — the box ends up framing empty
  space where the element used to be. This is a known limitation of
  the fallback path.

The CDP path also handles `boundingBox()`-failure cases (e.g. a
detached stash node) by falling back to the JS overlay reusing the
same per-statement sequence number, so screenshots remain numbered
contiguously.

### Off-viewport targets

The capture pipeline takes two different paths to make sure
off-viewport targets still produce useful screenshots, depending on
whether the target is the subject of a locator **action** or a
locator **assertion**:

- **Locator actions** (`click`, `fill`, `hover`, …) — we call
  `locator.scrollIntoViewIfNeeded()` **before** the highlight
  screenshot. This is a no-op for the action's own state because
  Playwright's actions auto-scroll into view as part of
  actionability anyway; we are just doing it a few ms earlier so
  the screenshot matches what the action will see. The screenshot
  is then a regular viewport capture.
  - Note: `scrollIntoViewIfNeeded` is intentionally **not** in the
    patched-actions list (`HIGHLIGHTED_LOCATOR_ACTIONS` in
    `locator-patch.ts`). Patching it would cause infinite recursion
    when our own pre-screenshot scroll re-entered the patched
    method, and the standalone scroll-screenshot is redundant given
    every other action now scrolls-then-screenshots anyway.

- **Locator assertions** (`expect(locator).toBeVisible()`,
  `.not.toHaveText(…)`, …) — we **do not** scroll, because some
  assertions are viewport-sensitive: `toBeInViewport()` /
  `not.toBeInViewport()` would change outcome if the tracer scrolled
  before they ran. Instead, the screenshot is captured beyond the
  viewport — `Page.captureScreenshot { captureBeyondViewport: true }`
  on the CDP path, `page.screenshot({ fullPage: true })` on the JS
  fallback. The renderer composes the highlight at the element's
  document position regardless of scroll, so off-viewport assertion
  targets are still visible in the resulting PNG.
  - **Caveat:** assertion screenshots can be much larger than action
    screenshots — they are full-document captures, so for tall pages
    expect proportionally larger PNGs in `heal-data/`. We accept
    that cost as a trade for assertion-semantic safety.

### Decoration timeouts (`screenshotMs`)

Both paths cap their per-call locator measurements at 10 seconds
(`boundingBox` for the JS fallback; `locator.evaluate` for the CDP
stash/unstash). The same 10-second cap is applied to the
action-path `scrollIntoViewIfNeeded`, to every CDP `send`, to
`newCDPSession`, to the `page.screenshot` fallback, and to the
`page.evaluate` calls inside `drawOverlay` / `removeOverlay`.
Without these caps, Playwright auto-waits the locator-resolution
calls for the full configured `actionTimeout`, and CDP itself has
no protocol-level timeout — a wedged renderer (alert dialog, JS
deadlock, hung navigation) could otherwise let screenshot
decoration outlast the action it is decorating. Decoration must
always fail-fast so the test fails on the user's actual action,
not on the tracer's overlay.

Capture is best-effort: if any of these caps fires the rejection
is silently swallowed, the screenshot is dropped (or, for the
action-path scroll, the un-scrolled state is captured), any
partially-drawn overlay is still cleaned up via the cleanup
closure, and the original action proceeds normally. In particular
the action-path `scrollIntoViewIfNeeded` is wrapped in its own
`try`/`catch` — a slow page that doesn't settle within
`screenshotMs` produces a viewport-only screenshot of wherever
the page currently is, rather than failing the test. Playwright's
own actionability check then runs again as part of the user's
action and gets the full project `actionTimeout` to scroll and
act, so a transient slowness in our pre-screenshot scroll never
turns into a test failure.

The cap value is configurable — see [`configuration.md`](configuration.md).
