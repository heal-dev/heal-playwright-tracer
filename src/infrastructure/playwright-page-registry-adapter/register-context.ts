/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Registers a BrowserContext with a PageRegistry: the context gets its
// id, every page it already has gets a page id plus a video watcher,
// and every page it opens later (popups, new windows) gets the same at
// creation time — which is what makes `videoStartWallMs` an accurate
// anchor rather than a first-action-time guess.
//
// One context is one context whichever API produced it: the fixture's
// Browser patches (`wireAllPages`) call this for `browser.newContext` /
// `browser.newPage`, and the Electron launch hook calls it for
// `app.context()`. Best-effort throughout: a Playwright call throwing
// here must never break wiring.

import type { BrowserContext } from 'playwright';
import type { PageRegistry } from './page-registry';
import { watchPageVideo } from './watch-page-video';

export function registerContext(registry: PageRegistry, ctx: BrowserContext): void {
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
