/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// PageRegistry — assigns every BrowserContext and Page a stable id for
// one test, so a statement can be linked to the page (and therefore
// the recorded video) its action / assertion / navigation touched.
//
// Ids are `ctx{n}/p{m}`: the n-th context to be seen gets `ctx{n}`,
// and the m-th page within that context gets `/p{m}`. The test's
// primary page — registered first by the fixture — is therefore
// `ctx0/p0`. Ids are assigned once and memoised on WeakMaps keyed by
// the Playwright object, so repeated lookups are stable and cost
// nothing after the first.
//
// A registry instance is per-test (the fixture creates one at setup
// and drops it at teardown). It keeps a strong list of entries
// alongside the WeakMaps purely so the fixture can enumerate every
// page it saw at teardown (to map videos back to page ids); the strong
// refs live no longer than the test.

import type { BrowserContext, Page } from 'playwright';

/** What produced a context, when it is not a plain browser context. */
export type PageKind = 'electron';

/**
 * A mark set on a context (see `PageRegistry.markContext`) and copied
 * onto every page entry of that context, registered before or after.
 */
export interface ContextMark {
  /** What produced this context. Absent for a plain browser context. */
  kind?: PageKind;
  /**
   * `false` when the tracer must leave this context alone at teardown:
   * an app the host registered by hand (`registerElectronApp`) and still
   * owns. Absent means the test owns it — closed at teardown so its
   * video flushes, like a manual `browser.newContext`.
   */
  owned?: false;
}

export interface PageEntry {
  /** Stable `ctx{n}/p{m}` id. */
  pageId: string;
  /** The page itself. Held only for the lifetime of the registry (one test). */
  page: Page;
  /**
   * `Date.now()` captured when this page was first registered — the
   * Tier 1 approximation of the page's video start instant. The
   * fixture copies it onto the video attachment so a consumer can map
   * a statement's `wallTime` to an offset into the recording.
   */
  videoStartWallMs: number;
  /**
   * Recording-time path of this page's video, resolved once the page
   * closes (Playwright's `Video.path()` only settles then). Present
   * only for pages whose context closed before the fixture's teardown
   * read it — i.e. manually-created contexts that a test closes itself.
   *
   * This is the path the test passes to `testInfo.attach({ path })`,
   * NOT what the reporter sees: Playwright copies an attached file to a
   * content-hashed name. The fixture joins this to the attachment's
   * final path (captured by intercepting `testInfo.attach`) to label
   * the video with this page's id. Absent until/unless resolved.
   */
  videoRecordingPath?: string;
  /**
   * Resolves to this page's recording-time video path once its context
   * closes (or `null` if it never resolves / recordVideo is off). Lets
   * the fixture await a manual context's video at teardown and
   * auto-attach the file — so a manual context's video lands in
   * heal-traces without the test calling `testInfo.attach` itself.
   * Settled by `watchPageVideo`.
   */
  videoPathPromise?: Promise<string | null>;
  /**
   * Copied from the context's mark. Absent for a plain browser page;
   * `'electron'` for a window of an app launched with `_electron.launch()`.
   */
  kind?: PageKind;
  /**
   * Copied from the context's mark. `false` when the tracer must not
   * close this page's context nor attach its video at teardown.
   */
  owned?: false;
}

function applyMark(entry: PageEntry, mark: ContextMark): void {
  if (mark.kind !== undefined) entry.kind = mark.kind;
  if (mark.owned !== undefined) entry.owned = mark.owned;
}

export class PageRegistry {
  private readonly contextIds = new WeakMap<BrowserContext, string>();
  private readonly contextPageCounts = new WeakMap<BrowserContext, number>();
  private readonly contextMarks = new WeakMap<BrowserContext, ContextMark>();
  private readonly entriesByContext = new WeakMap<BrowserContext, PageEntry[]>();
  private readonly pageIds = new WeakMap<Page, string>();
  private readonly entriesByPage = new WeakMap<Page, PageEntry>();
  private readonly entries: PageEntry[] = [];
  private nextContextIndex = 0;

  // Injectable wall clock so tests can assert deterministic
  // videoStartWallMs values. Defaults to Date.now in production.
  constructor(private readonly now: () => number = Date.now) {}

  /** Assign (or return the existing) id for a context. */
  ensureContextId(ctx: BrowserContext): string {
    const existing = this.contextIds.get(ctx);
    if (existing !== undefined) return existing;
    const id = `ctx${this.nextContextIndex++}`;
    this.contextIds.set(ctx, id);
    this.contextPageCounts.set(ctx, 0);
    return id;
  }

  /**
   * Assign (or return the existing) id for a page, registering its
   * context first if needed. Safe to call repeatedly and from the hot
   * path — after the first call it is a single WeakMap read.
   */
  ensurePageId(page: Page): string {
    const existing = this.pageIds.get(page);
    if (existing !== undefined) return existing;

    const ctx = page.context();
    const ctxId = this.ensureContextId(ctx);
    const pageIndex = this.contextPageCounts.get(ctx) ?? 0;
    this.contextPageCounts.set(ctx, pageIndex + 1);

    const pageId = `${ctxId}/p${pageIndex}`;
    this.pageIds.set(page, pageId);
    const entry: PageEntry = { pageId, page, videoStartWallMs: this.now() };
    const mark = this.contextMarks.get(ctx);
    if (mark) applyMark(entry, mark);
    this.entriesByPage.set(page, entry);
    this.entries.push(entry);
    const siblings = this.entriesByContext.get(ctx);
    if (siblings) siblings.push(entry);
    else this.entriesByContext.set(ctx, [entry]);
    return pageId;
  }

  /**
   * Mark a context with what produced it and whether the test owns it.
   * Pages registered later inherit the mark, and pages already
   * registered for this context are back-filled — so the call is
   * order-proof: an Electron window may be registered (by the stamper
   * or a `page` event) before the launch hook gets to mark its context.
   */
  markContext(ctx: BrowserContext, mark: ContextMark): void {
    const merged: ContextMark = { ...this.contextMarks.get(ctx), ...mark };
    this.contextMarks.set(ctx, merged);
    for (const entry of this.entriesByContext.get(ctx) ?? []) applyMark(entry, merged);
  }

  /** Lookup without assigning. Returns undefined for an unseen page. */
  idForPage(page: Page): string | undefined {
    return this.pageIds.get(page);
  }

  /** The entry for a page, or undefined if never registered. */
  entryForPage(page: Page): PageEntry | undefined {
    return this.entriesByPage.get(page);
  }

  /**
   * Record the resolved recording-time video path for a page. No-op
   * for an unregistered page. Called asynchronously once the page
   * closes (see `watchPageVideo`).
   */
  setVideoRecordingPath(page: Page, videoRecordingPath: string): void {
    const entry = this.entriesByPage.get(page);
    if (entry) entry.videoRecordingPath = videoRecordingPath;
  }

  /**
   * Store the promise that resolves to a page's recording-time video
   * path once its context closes. No-op for an unregistered page.
   * Called at registration by `watchPageVideo`.
   */
  setVideoPathPromise(page: Page, videoPathPromise: Promise<string | null>): void {
    const entry = this.entriesByPage.get(page);
    if (entry) entry.videoPathPromise = videoPathPromise;
  }

  /** Every page seen this test, in registration order. */
  list(): PageEntry[] {
    return this.entries.slice();
  }
}
