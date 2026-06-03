/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Helper that wires every BrowserContext / APIRequestContext for a
// test's network and console capture sessions, including ones the
// test creates after fixture setup.
//
// Two layers of coverage:
//
//   1. Existing contexts at fixture time
//      - `browser.contexts()` is iterated and each context is fed
//        to the sessions immediately. Covers the test's
//        page.context() plus any other context already living in
//        the worker (rare; some setups share contexts between
//        tests via storageState).
//
//   2. Newly-created contexts after fixture time
//      - `browser.newContext` and `browser.newPage` are patched on
//        the shared (worker-scoped) Browser instance. The patches
//        delegate to the originals, then attach the resulting
//        context to every session before returning.
//      - The global `playwright.request.newContext` is patched the
//        same way so api-request contexts created inside the test
//        body are also covered.
//
// The patches are reverted by the returned `restore()` thunk so a
// later test in the same worker sees a clean Browser. We only undo
// our own patch — if user code wrapped the same method between our
// patch and our restore, theirs stays in place.

import type { APIRequest, APIRequestContext, Browser, BrowserContext, Page } from 'playwright';
import {
  watchPageVideo,
  type PageRegistry,
} from '../../infrastructure/playwright-page-registry-adapter';

/**
 * Capture sessions implement just enough of the `Wireable`
 * surface for this helper. Both `NetworkCaptureSession` and
 * `ConsoleCaptureSession` already match — the typing is structural
 * to avoid an import cycle between the fixture and the adapters.
 */
export interface WireableContextSession {
  attachToContext(ctx: BrowserContext): void;
}

export interface WireableApiSession {
  attachToApiRequestContext?(api: APIRequestContext): void;
}

export type WireableSession = WireableContextSession & WireableApiSession;

export interface WireAllPagesOptions {
  browser: Browser;
  /**
   * Optional reference to the global `request` from `@playwright/test`
   * (an `APIRequest`). Pass it to also patch `request.newContext` so
   * api-request contexts created inside the test body are wired.
   */
  apiRequest?: APIRequest;
  /**
   * Optional per-test page registry. When supplied, every context and
   * page this helper observes (existing, newly-created, and popups via
   * `context.on('page')`) is assigned a stable id at creation time.
   * That gives an accurate per-page video-start anchor and lets the
   * fixture enumerate every page at teardown to map videos back to
   * page ids. Page attribution still works without it via the
   * action-time fallback in the stamper, just with first-action-time
   * (rather than creation-time) registration.
   */
  pageRegistry?: PageRegistry;
}

/**
 * Register a context and all its current pages in the registry, and
 * subscribe to future pages (popups) opened in it. Best-effort: a
 * Playwright call throwing here must never break wiring.
 */
function registerContext(registry: PageRegistry, ctx: BrowserContext): void {
  try {
    registry.ensureContextId(ctx);
    for (const p of ctx.pages()) {
      registry.ensurePageId(p);
      watchPageVideo(registry, p);
    }
    ctx.on('page', (p) => {
      try {
        registry.ensurePageId(p);
        watchPageVideo(registry, p);
      } catch {
        // A page event for an already-closing context — ignore.
      }
    });
  } catch {
    // Context already closed / detached — nothing to register.
  }
}

/** Returns a `restore()` thunk that undoes all patches. */
export function wireAllPages(sessions: WireableSession[], opts: WireAllPagesOptions): () => void {
  const { browser, apiRequest, pageRegistry } = opts;

  // (1) Wire every existing BrowserContext.
  for (const ctx of browser.contexts()) {
    for (const session of sessions) session.attachToContext(ctx);
    if (pageRegistry) registerContext(pageRegistry, ctx);
  }

  // (2) Patch newly-created contexts. We hold references to the
  // ORIGINAL methods (no `.bind`) so `restore()` returns the exact
  // same function reference user code may have captured before
  // wiring. Inside our wrapper we use `.call(browser, …)` to keep
  // `this` correctly bound on invocation.
  const originalNewContext = browser.newContext;
  const originalNewPage = browser.newPage;

  browser.newContext = async (...args: Parameters<Browser['newContext']>) => {
    const ctx = await originalNewContext.call(browser, ...args);
    for (const session of sessions) session.attachToContext(ctx);
    if (pageRegistry) registerContext(pageRegistry, ctx);
    return ctx;
  };

  browser.newPage = async (...args: Parameters<Browser['newPage']>) => {
    const page = await originalNewPage.call(browser, ...args);
    const ctx = page.context();
    for (const session of sessions) session.attachToContext(ctx);
    if (pageRegistry) registerContext(pageRegistry, ctx);
    return page;
  };

  // (3) Patch the global APIRequest factory if we were handed one
  // and any session implements `attachToApiRequestContext`.
  let originalApiNewContext: APIRequest['newContext'] | undefined;
  if (apiRequest && sessions.some((s) => s.attachToApiRequestContext)) {
    originalApiNewContext = apiRequest.newContext;
    apiRequest.newContext = async (...args: Parameters<APIRequest['newContext']>) => {
      const api = await originalApiNewContext!.call(apiRequest, ...args);
      for (const session of sessions) {
        session.attachToApiRequestContext?.(api);
      }
      return api;
    };
  }

  return function restore() {
    // Always restore. If user code re-patched our wrapper in the
    // meantime, theirs gets reverted too — they own the conflict.
    browser.newContext = originalNewContext;
    browser.newPage = originalNewPage;
    if (apiRequest && originalApiNewContext) {
      apiRequest.newContext = originalApiNewContext;
    }
  };
}

/**
 * Wire a single page (and its context) eagerly. Used by the fixture
 * for the test's initial `page` so the first request fired by the
 * test body is captured even if it races with the `attachToContext`
 * call for a sibling context.
 */
export function wireInitialPage(sessions: WireableSession[], page: Page): void {
  const ctx = page.context();
  for (const session of sessions) session.attachToContext(ctx);
}
