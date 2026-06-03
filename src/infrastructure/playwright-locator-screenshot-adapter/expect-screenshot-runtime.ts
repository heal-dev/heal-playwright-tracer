/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Runtime side of the expect-screenshot feature.
//
// The Babel plugin inserts `await globalThis.__heal_expect_screenshot?.(target)`
// in front of every `await expect(target).…` / `await expect.soft(target).…`
// in instrumented test files (see
// `application/babel-playwright-tracer-plugin/index.ts`). This module
// owns the runtime end of that contract:
//
//   - `expectScreenshotHelper(target)` — the function the plugin's
//     synthetic call resolves to. Duck-types `target` as a Locator
//     (same shape check as the action patch) and, if it matches, runs
//     the active `ScreenshotCaptureSession`'s capture pipeline. The
//     overlay is drawn and immediately torn down before the helper
//     returns, so by the time the user's `expect(...)` matcher
//     executes the page is in its original state — important because
//     a stray overlay could in principle affect what the assertion
//     observes (e.g. screen-reader-driven matchers).
//
//   - `installExpectScreenshotGlobal()` / `uninstallExpectScreenshotGlobal()` —
//     symmetric global-slot management called by the fixture at
//     test start / teardown. The slot stays `undefined` outside any
//     test so the optional call in instrumented source is a no-op.
//
// Capture is always best-effort: any rejection out of
// `captureWithHighlight` is logged and swallowed so a screenshot
// failure never breaks the user's assertion.

import type { Locator, Page } from 'playwright';
import { getActiveCaptureSession } from './locator-patch';
import { getActivePageStamper } from '../playwright-page-registry-adapter';
import { HEAL_EXPECT_SCREENSHOT } from '../../domain/trace-event-recorder/model/global-names';
import { log } from '../../util/logger';

// Same duck-type as the action-side patch: a Playwright Locator
// always has both `.boundingBox` and `.page` as functions. FrameLocator,
// ElementHandle, Page, and plain values won't match.
function isLocator(target: unknown): target is Locator {
  if (!target || typeof target !== 'object') return false;
  const obj = target as Record<string, unknown>;
  return typeof obj.boundingBox === 'function' && typeof obj.page === 'function';
}

// Resolve the locator's current match count without auto-waiting.
// `locator.count()` returns synchronously-ish (a single CDP roundtrip)
// and never blocks waiting for the element to appear, so it's safe to
// call up-front to distinguish "element present, capture with overlay"
// from "element absent, fall back to plain viewport screenshot".
// Returns -1 on probe failure (`count` missing, throws) so the caller
// treats it like "present" and proceeds with the normal pipeline.
async function probeLocatorCount(target: Locator): Promise<number> {
  const counter = (target as { count?: () => Promise<number> }).count;
  if (typeof counter !== 'function') return -1;
  try {
    return await counter.call(target);
  } catch (err) {
    log.warn('expectScreenshotHelper count() probe rejected', err);
    return -1;
  }
}

export interface ExpectScreenshotOptions {
  /**
   * Whether to scroll the target into view before capturing. Defaults
   * to `true`. The Babel plugin emits `{ scroll: false }` only for
   * viewport-sensitive matchers (`toBeInViewport`, `not.toBeInViewport`)
   * where scrolling would alter the assertion's outcome.
   */
  scroll?: boolean;
}

export async function expectScreenshotHelper(
  target: unknown,
  options?: ExpectScreenshotOptions,
): Promise<void> {
  if (!isLocator(target)) return;
  const page = typeof target.page === 'function' ? (target.page() as Page | null) : null;
  // Attribute this assertion to its target page — done before (and
  // independent of) screenshot capture, so attribution still works
  // even if screenshots are disabled. Stamps the URL the page is on at
  // assertion time.
  if (page) {
    try {
      getActivePageStamper()?.(page);
    } catch (err) {
      log.warn('page stamp failed for expect', err);
    }
  }
  const session = getActiveCaptureSession();
  if (!session) return;
  if (!page) return;

  // Probe match count first. The user may be asserting that an element
  // is absent (`toHaveCount(0)`, `toBeHidden()`, `.not.toBeVisible()`)
  // — in that case `scrollIntoViewIfNeeded` and `boundingBox` would
  // each auto-wait the full `screenshotTimeoutMs` for an element that
  // is never going to appear (two ten-second stalls per assertion).
  // `count()` returns immediately, so we fork the pipeline up-front
  // and fall back to a plain viewport screenshot when there's nothing
  // to frame.
  const count = await probeLocatorCount(target);
  if (count === 0) {
    try {
      await session.captureViewportOnly(page, 'expect');
    } catch (err) {
      log.warn('expectScreenshotHelper captureViewportOnly rejected', err);
    }
    return;
  }

  const scrollBeforeCapture = options?.scroll !== false;

  let cleanup: (() => Promise<void>) | null = null;
  try {
    cleanup = await session.captureWithHighlight(page, target, 'expect', {
      scrollBeforeCapture,
    });
  } catch (err) {
    log.warn('expectScreenshotHelper captureWithHighlight rejected', err);
  }

  if (cleanup) {
    try {
      await cleanup();
    } catch (err) {
      log.warn('expectScreenshotHelper overlay cleanup rejected', err);
    }
  }
}

export function installExpectScreenshotGlobal(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g[HEAL_EXPECT_SCREENSHOT] = expectScreenshotHelper;
}

export function uninstallExpectScreenshotGlobal(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g[HEAL_EXPECT_SCREENSHOT];
}
