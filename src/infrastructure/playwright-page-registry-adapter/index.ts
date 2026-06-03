/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Feature: page-attribution — assigns every page/context a stable id
// for one test and stamps that id (plus the page's live URL) onto the
// statement whose Locator action / `expect` assertion / Page
// navigation touched it. Joins to `TestAttachment.pageId` so a
// statement can be resolved to the recorded video it appears in.
//
//   - page-registry.ts        — per-test PageRegistry (ctx{n}/p{m} ids)
//   - active-page-stamper.ts  — process-global slot the patch sites read
//   - page-navigation-patch.ts — Page.prototype nav-method interception
//   - start-page-attribution.ts — per-test wiring entry point

export { PageRegistry, type PageEntry } from './page-registry';
export {
  setActivePageStamper,
  getActivePageStamper,
  type PageStamper,
} from './active-page-stamper';
export { ensurePageNavigationPatched, PAGE_NAVIGATION_METHODS } from './page-navigation-patch';
export { startPageAttribution, type OnPageResolved } from './start-page-attribution';
export { watchPageVideo } from './watch-page-video';
export {
  patchTestInfoAttach,
  type AttachableTestInfo,
  type OnVideoAttached,
} from './patch-testinfo-attach';
