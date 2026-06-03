# Linking executed statements to recorded videos

## Goal

Every statement in `heal-traces.ndjson` should resolve to a moment in a
recorded Playwright `.webm`, so the viewer can jump to the video frame a
step ran on. This is **two independent joins**:

```
  STATEMENT ─┬─ WHEN  (wallTime, already on every event) ──► offsetSec =
             │                                               (wallTime − videoStart) / 1000
             │
             └─ WHERE (pageId) ───────────────────────────► which .webm file
                      (+ pageUrl: where the page was when the statement ran)
```

`wallTime` (`Date.now()` at emit) already rides on every `enter`/`ok`/`throw`
event, so the _when_ half is solved. The work is **page identity** (the join
that also makes the offset meaningful in a multi-context test) plus a **time
anchor**.

### Why page identity is the hard half

A test like `heal-stories-heal`'s verdict suite launches several browser
contexts — the built-in `page` context plus the manually-created
`operator` / `admin` / `member` role contexts from `withRecordedContext` —
each recording its own `.webm`, with multiple pages inside. Today a
statement carries no record of _which_ page (and therefore which video) its
action touched, so a computed video offset would seek into an arbitrary
file. Page identity is the spine that makes every other part correct.

## Architecture

```
  page/context creation                 action time                 reporter (onTestEnd)
  ─────────────────────                 ───────────                 ────────────────────

  newContext / newPage ─┐
  context.on('page')    ├─► REGISTRY ──► stamp pageId + pageUrl ──► reconcile each video
  wireInitialPage      ─┘   WeakMap        on the statement          to a pageId, attach
                            <Page,id>      (top enter event)          videoStartWallMs

  ctx0/p0 = main        built-in page
  ctx1/p0 = operator ─┐
  ctx2/p0 = admin      ├─ manual contexts (withRecordedContext)
  ctx3/p0 = member    ─┘
```

One stable id per page, assigned once at creation, used by **both** join
sides: the statement stamp and the video label.

## Part A — Per-test page/context registry (the spine)

A tracer-owned registry maps every page and context to a stable id:

- `WeakMap<Page, string>` and `WeakMap<BrowserContext, string>`, id scheme
  `ctx{n}/p{m}`. The primary fixture page is `ctx0/p0`, aliased to the human
  label `main` to stay compatible with today's `pageName` (`main`,
  `page-1`, …).
- Populated at the choke points the tracer **already patches**:
  - `wireAllPages` wraps `browser.newContext` / `browser.newPage`
    (`src/application/playwright-fixture/wire-all-pages.ts:79`) — so it
    already observes the manual `withRecordedContext` contexts.
  - `context.on('page')` for popups opened inside a context.
  - `wireInitialPage` for the test's primary page.
- Assignment is idempotent (WeakMap-keyed), scoped to one test, cleared on
  teardown so a later test in the same worker starts clean.

The registry is the single source of truth; everything downstream reads ids
from it rather than recomputing them.

## Part B — Stamping `pageId` + `pageUrl` onto statements

Mirror the existing screenshot-stamp path. The recorder already stamps a
highlight-screenshot filename onto whatever `enter` event is on top of the
active-enter stack (`setCurrentStatementScreenshot`,
`src/domain/trace-event-recorder/service/trace-event-recorder.ts:113`). Add a
sibling:

```ts
setCurrentStatementPage(pageId: string, pageUrl: string): void
//   stamps `pageId` / `pageUrl` onto the top active-enter event.
```

`pageUrl` is a synchronous `page.url()` read at the same site — no extra
await, no perf cost. Three call sites, one per coverage class:

| Statement kind                                  | page resolved from                                         | mechanism                                                                | URL timing                                   |
| ----------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------- |
| Locator action (`click`, `fill`, …)             | `self.page()` — already computed at `locator-patch.ts:105` | one extra call beside the screenshot stamp; **no new interception**      | stamped before the action → origin URL       |
| Assertion (`expect(loc).toBeVisible()`)         | the expect target locator → `.page()`                      | stamp in the expect-screenshot runtime (already wraps `expect(locator)`) | URL at assert time                           |
| Page-level nav (`page.goto`, `page.waitForURL`) | `this` is the Page                                         | new idempotent `Page.prototype` patch (nav methods only)                 | stamped **after** the call → destination URL |

Navigation is the one case stamped _after_ the call, so its `pageUrl` is the
page it landed on, not the one it left.

## Part C — Reconciling each video to a `pageId`

Two video sources need two matching strategies:

- **Built-in context videos** — Playwright renames the file between fixture
  teardown (recording-time hash) and `onTestEnd` (`video[-N].webm`), so path
  matching fails. Keep the existing **positional** pairing
  (`src/infrastructure/heal-reporter/heal-tracer-reporter.ts:483`), but order
  from the registry (page-creation order) and attach the registry `pageId`.
- **Manual-context videos** — `withRecordedContext` resolves
  `await video.path()` after close and attaches that final path via
  `testInfo.attach('video', { path })`, so the attachment path is stable. The
  fixture records `{ pageId → page.video().path() }` at teardown; the reporter
  **matches by path**. These are the videos that get no label today.

Reporter algorithm:

1. For each `video/*` attachment, try a path match against the registry map
   (catches manual videos).
2. Fall back to positional pairing among the remaining attachments (catches
   renamed built-in videos).
3. Either way, stamp `pageId` (and `videoStartWallMs`) onto the
   `TestAttachment`.

## Part D — Time anchor (tiered)

```
  offsetSec = (statement.wallTime − videoStartWallMs[pageId]) / 1000
```

- **Tier 1 (ship first).** Capture `Date.now()` per page at
  registry-assignment time (creation). Rides entirely on the registry — no
  trace parsing. Accuracy ≈ sub-second, with a small systematic early bias
  (context creation precedes video frame 0).
- **Tier 2 (later accuracy upgrade).** The reporter unzips `trace.zip` and
  reads each `screencast-frame` event's `frameSwapWallTime` (browser-clock,
  frame-exact); the min per page is that page's true frame-0 wall time.
  `trace: 'on'` is already standard in the target config, so the data is
  present. Leave a clean seam for this; do not build it in v1.

The `.webm`-vs-screencast-frame timeline question (sub-second skew between
the muxed video and the screencast stream) only matters once Tier 2 lands and
is a viewer-side (run-viewer / heal-frontend) concern — out of scope here.

## Schema changes

All additive. Bump `HEAL_TRACE_SCHEMA_VERSION`.

| Type                                                                                     | New fields                                                                                        |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `Statement` / `EnterEvent`                                                               | `pageId?: string`, `pageUrl?: string` (optionally `videoKind?: 'action' \| 'assertion' \| 'nav'`) |
| `TestAttachment` (`src/domain/trace-event-recorder/model/statement-trace-schema.ts:246`) | `pageId?: string`, `videoStartWallMs?: number`                                                    |
| `VideoPageInfo` (`src/infrastructure/heal-reporter/heal-tracer-reporter.ts:99`)          | `pageId`, `videoStartWallMs`                                                                      |

Note: the new per-statement `pageUrl` is **distinct** from the existing
`TestAttachment.pageUrl` (`statement-trace-schema.ts:273`), which is the
page's URL captured once at teardown for a video. The statement field is
per-step.

## Risks & edge cases

- **Page closed before teardown** — its `page.video().path()` is
  unresolvable, so that video degrades to positional / un-enriched (exactly
  today's behaviour). No regression.
- **Remote / grid browsers** — node↔browser clock skew weakens the Tier 1
  anchor; Tier 2 (browser-stamped `frameSwapWallTime`) is the fix.
- **`Page.prototype` patch** is the only genuinely new interception — keep it
  idempotent (Symbol marker, like the Locator patch) and narrow (navigation
  methods only) to avoid recursion or surprising third-party code.
- **Statement with no page** (pure JS/TS) — never stamped; `pageId`/`pageUrl`
  stay absent, which is correct.

---

# Implementation plan

Ordered so each step is independently testable and the feature is usable
after step 4 (statements know their page) and complete after step 7.

## Implementation status

**Done — Parts A + B (statement-side attribution).** Every Locator action,
`expect(locator)` assertion, and `Page` navigation statement now carries
`pageId` (`ctx0/p0`, …) and the targeted page's `pageUrl`. Verified by unit
tests and an end-to-end integration assertion against real Chromium.

Notes vs. the original plan:

- The registry lives in a new **infrastructure** adapter
  (`src/infrastructure/playwright-page-registry-adapter/`), not under
  `application/`, so the process-global patch sites can reach it via an
  active-stamper holder (mirroring the screenshot adapter's
  active-session registry). The fixture owns the per-test instance.
- `EnterEvent.pageUrl` / `Statement.pageUrl` **already existed** (fed by the
  recorder's manual, global `currentPage` / `setPage`, which had no internal
  caller). The new per-action stamp supersedes that value with the specific
  page the statement touched; the enter-time `currentPage` read remains the
  fallback. Only `pageId` is a genuinely new field.
- `HEAL_TRACE_SCHEMA_VERSION` bumped 3 → 4.
- Files: `page-registry.ts`, `active-page-stamper.ts`,
  `page-navigation-patch.ts`, `start-page-attribution.ts`; recorder
  `setCurrentStatementPage`; projector `applyLateEnterFields`; locator-patch
  and expect-runtime stamps; `wire-all-pages.ts` registry registration;
  fixture wiring.

**Done — Parts C + D (video reconciliation + anchor emission).** Every video
`TestAttachment` now carries the recording page's `pageId` and the Tier 1
`videoStartWallMs` anchor, so a statement resolves to a specific `.webm`.
Verified by reporter unit tests and a real multi-context integration spec
(built-in + a `withRecordedContext`-style manual context).

One reality the original plan got wrong: a manual video can't be matched by
its recording path, because Playwright **copies a `testInfo.attach({ path })`
file to a content-hashed name** (`video-<sha1>.webm`) and the reporter sees
that copy, not the recording path. So matching by `page.video().path()`
alone fails. The implemented join instead intercepts `testInfo.attach`
(`patch-testinfo-attach.ts`) to capture each video's **final** attachment
path, and joins it — at teardown, race-free — to the recording path the
registry captured on page close (`watch-page-video.ts`). The reporter then
matches manual videos by that final path and falls back to positional
pairing for the built-in context's (renamed) video.

Other notes:

- `wireAllPages` is now called **unconditionally** (previously only when a
  sidecar session was enabled) so the registry observes every
  manually-created context even with network/console capture off.
- New files: `watch-page-video.ts`, `patch-testinfo-attach.ts`; the registry
  gained `videoRecordingPath` + `setVideoRecordingPath`; `VideoPageInfo` and
  `TestAttachment` gained `pageId` / `videoStartWallMs` (+ `videoPath` on
  `VideoPageInfo` for the path match); reporter reconciliation rewritten as
  path-match-then-positional; `sanitizeVideoPages` extended.

Tier 2 (frame-exact anchor from `trace.zip` screencast `frameSwapWallTime`)
remains intentionally unbuilt — the `videoStartWallMs` field is the seam.

### 1. Page/context registry

- New module, e.g.
  `src/application/playwright-fixture/page-registry.ts`: `WeakMap`-backed
  id assignment (`assignContext`, `assignPage`, `idForPage`,
  `videoPathForPage`), per-test instance.
- Unit test: ids stable across repeated lookups, distinct per page, primary
  page → `ctx0/p0`/`main`.

### 2. Wire registry into page discovery

- `wire-all-pages.ts`: assign ids in the `newContext` / `newPage` wrappers and
  add `context.on('page')`; assign the initial page in `wireInitialPage`.
- Thread the registry instance through `WireAllPagesOptions`.
- Test: a test that opens a popup and a second context gets three distinct ids.

### 3. Recorder stamp method

- `trace-event-recorder.ts`: add `setCurrentStatementPage(pageId, pageUrl)`
  mirroring `setCurrentStatementScreenshot`; stamp top active-enter event.
- `enter-event-builder.ts` + `statement-projector.ts`: pass `pageId`/`pageUrl`
  through (same optional-field pattern as `screenshot`/`leadingComment`).
- Schema: add fields to `EnterEvent` and `Statement`; bump
  `HEAL_TRACE_SCHEMA_VERSION`.
- Test: recorder unit test asserting the stamp lands on the right event.

### 4. Stamp locator actions (smallest end-to-end slice)

- `locator-patch.ts:105`: resolve `pageId` from the registry and call
  `setCurrentStatementPage(pageId, pg.url())` beside the screenshot stamp.
- Wire the registry → recorder callback in the fixture (mirror
  `onScreenshotWritten`).
- Integration test: a `click` statement carries `pageId` + `pageUrl`.

### 5. Stamp assertions and page-level navigations

- Expect-screenshot runtime: stamp from the assertion's target locator page.
- New `Page.prototype` nav patch (idempotent, nav methods only); stamp
  _after_ the call for destination URL.
- Tests: an `expect(locator)` and a `page.goto` each carry the right
  `pageId`/`pageUrl`.

### 6. Tier 1 time anchor

- Capture `Date.now()` per page at registry assignment; store
  `videoStartWallMs` on the registry entry.
- Fixture teardown (`playwright-fixture/index.ts:367`): record
  `{ pageId, videoPath, videoStartWallMs }` per page; extend `VideoPageInfo`.
- Test: registry exposes a per-page anchor.

### 7. Video → pageId reconciliation in the reporter

- `heal-tracer-reporter.ts:483-528`: path-match manual videos, positional
  fallback for renamed built-in videos; stamp `pageId` + `videoStartWallMs`
  onto each `TestAttachment`.
- Add `pageId`/`videoStartWallMs` to `TestAttachment` and `sanitizeVideoPages`.
- Integration test: a multi-context test (built-in + one manual context)
  produces video attachments each labelled with the correct `pageId`.

### 8. Docs + viewer contract

- Update `docs/configuration.md` (the video / attachments section) with the
  new fields.
- Note the Tier 2 seam (`trace.zip` screencast `frameSwapWallTime`) as future
  work.

### Tier 2 (separate, later)

- Reporter unzips `trace.zip`, parses `screencast-frame` events, derives
  per-page frame-0 `frameSwapWallTime`, overrides `videoStartWallMs` when
  present. No schema change beyond what step 7 already adds.
