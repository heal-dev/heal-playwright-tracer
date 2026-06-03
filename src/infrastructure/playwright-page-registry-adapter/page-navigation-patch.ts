/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Prototype-patches `Page.prototype` navigation methods so a statement
// that navigates (rather than acting on a Locator) is still attributed
// to its page. Locator actions and `expect(locator)` assertions are
// covered elsewhere (locator-patch / expect-screenshot-runtime); this
// fills the Page-level gap.
//
// Unlike the Locator action patch, the page stamp fires AFTER the
// original method resolves, so the stamped URL is the destination the
// navigation landed on, not the origin it left.
//
// The patch runs once per process and is idempotent via a Symbol
// marker on the Page prototype. It only wraps navigation methods — no
// queries, no actions — to keep the interception surface minimal.

import type { Page } from 'playwright';
import { getActivePageStamper } from './active-page-stamper';
import { log } from '../../util/logger';

// Page-level navigation methods. These change the page's URL, so
// stamping after they resolve records where the statement ended up.
export const PAGE_NAVIGATION_METHODS = ['goto', 'goBack', 'goForward', 'reload', 'waitForURL'];

const PATCHED = Symbol.for('heal-playwright-tracer.page-nav-patched');

interface PatchableProto {
  [PATCHED]?: boolean;
  [key: string]: unknown;
}

// Idempotent proto patch. Call once per process with any Page instance —
// we grab its prototype and overwrite every navigation method.
export function ensurePageNavigationPatched(samplePage: Page): void {
  const proto = Object.getPrototypeOf(samplePage) as PatchableProto;
  if (!proto || proto[PATCHED]) return;
  proto[PATCHED] = true;

  for (const name of PAGE_NAVIGATION_METHODS) {
    const orig = proto[name];
    if (typeof orig !== 'function') continue;
    proto[name] = async function patched(this: unknown, ...args: unknown[]) {
      const self = this as Page;
      try {
        return await (orig as (...a: unknown[]) => Promise<unknown>).apply(self, args);
      } finally {
        // Stamp after the navigation settles (success OR failure) so
        // the URL reflects where we landed. Best-effort: a stamp
        // failure must never mask the navigation's own result.
        try {
          getActivePageStamper()?.(self);
        } catch (err) {
          log.warn(`page stamp failed for page.${name}`, err);
        }
      }
    };
  }
}
