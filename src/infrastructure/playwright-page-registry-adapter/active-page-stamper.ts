/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Active page-stamper registry — the process-global slot the patched
// Locator actions, the wrapped `expect` helper, and the patched Page
// navigation methods read to attribute the current statement to a page.
//
// Mirrors the active-capture-session registry in the locator-screenshot
// adapter: the prototype patches are process-global and lexically
// fixed, so they cannot close over a per-test registry directly. The
// fixture installs a stamper at test start (a closure over the per-test
// `PageRegistry` and the recorder's `setCurrentStatementPage`) and
// clears it at teardown. The patched methods call `getActivePageStamper`
// on every action and no-op when it is null (action fired outside a
// test, or before the fixture wired anything).
//
// The stamper takes the resolved target Page; the closure decides how
// to turn it into an id + URL and how to stamp it onto the trace.

import type { Page } from 'playwright';

export type PageStamper = (page: Page) => void;

let activeStamper: PageStamper | null = null;

export function setActivePageStamper(stamper: PageStamper | null): void {
  activeStamper = stamper;
}

export function getActivePageStamper(): PageStamper | null {
  return activeStamper;
}
