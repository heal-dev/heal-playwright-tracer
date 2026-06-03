/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Entry point for the page-attribution feature, mirroring
// `startLocatorScreenshotCapture`. The fixture calls this once per test:
//
//   - ensures the process-wide Page navigation patch is installed,
//   - registers the test's primary page in the per-test registry (so it
//     is `ctx0/p0`),
//   - installs the active page-stamper: a closure that resolves any
//     target page to its registry id + live URL and hands them to
//     `onPageResolved` (wired by the fixture to the recorder's
//     `setCurrentStatementPage`),
//   - returns a disposer that clears the stamper at teardown.
//
// The recorder is reached only through the injected `onPageResolved`
// callback, so this adapter stays decoupled from the recorder runtime
// (same dependency-injection shape as the screenshot feature's
// `onScreenshotWritten`).

import type { Page } from 'playwright';
import { PageRegistry } from './page-registry';
import { setActivePageStamper, type PageStamper } from './active-page-stamper';
import { ensurePageNavigationPatched } from './page-navigation-patch';
import { watchPageVideo } from './watch-page-video';
import { log } from '../../util/logger';

export type OnPageResolved = (pageId: string, pageUrl: string | undefined) => void;

// Tolerant page.url() read — Playwright throws on closed/detached
// pages, and that must never break attribution.
function safePageUrl(page: Page): string | undefined {
  try {
    return page.url();
  } catch (err) {
    log.warn('page.url() read failed during attribution', err);
    return undefined;
  }
}

export function startPageAttribution(
  samplePage: Page,
  registry: PageRegistry,
  onPageResolved: OnPageResolved,
): () => void {
  ensurePageNavigationPatched(samplePage);
  registry.ensurePageId(samplePage);
  watchPageVideo(registry, samplePage);

  const stamper: PageStamper = (page) => {
    const pageId = registry.ensurePageId(page);
    onPageResolved(pageId, safePageUrl(page));
  };
  setActivePageStamper(stamper);

  return () => setActivePageStamper(null);
}
