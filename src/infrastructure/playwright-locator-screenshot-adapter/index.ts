/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Feature: locator-screenshots — highlight + screenshot capture on
// every Playwright locator action and on every `expect(locator).…`
// / `expect.soft(locator).…` assertion the Babel plugin instruments.
//
// Public API:
//   startLocatorScreenshotCapture(samplePage, outputDir, onScreenshotWritten, screenshotTimeoutMs)
//     Ensures the process-wide Locator.prototype patch is installed,
//     creates a per-test capture session, registers it so both the
//     patched action methods and the global `__heal_expect_screenshot`
//     helper can find it, and installs that helper on `globalThis`.
//     `screenshotTimeoutMs` caps every async the capture pipeline
//     awaits — locator resolution, CDP sends, page.evaluate,
//     page.screenshot. Returns a disposer that clears the active
//     session and uninstalls the helper at test teardown.
//
// Class / helper locations:
//   - ScreenshotCaptureSession.ts        — per-test capture pipeline
//   - locator-patch.ts                   — process-global prototype patch + active-session registry
//   - expect-screenshot-runtime.ts       — runtime helper for the Babel-injected `expect` screenshot calls
//   - overlay-helpers.ts                 — stateless drawOverlay / removeOverlay

import type { Page } from 'playwright';
import { ensureLocatorPrototypePatched, setActiveCaptureSession } from './locator-patch';
import { ScreenshotCaptureSession } from './screenshot-capture-session';
import {
  installExpectScreenshotGlobal,
  uninstallExpectScreenshotGlobal,
  installExpectScreenshotAfterGlobal,
  uninstallExpectScreenshotAfterGlobal,
} from './expect-screenshot-runtime';

export function startLocatorScreenshotCapture(
  samplePage: Page,
  outputDir: string,
  onScreenshotWritten: (filename: string) => void,
  onRawScreenshotWritten: (filename: string) => void,
  screenshotTimeoutMs: number,
): () => void {
  ensureLocatorPrototypePatched(samplePage);
  const session = new ScreenshotCaptureSession(
    outputDir,
    onScreenshotWritten,
    onRawScreenshotWritten,
    screenshotTimeoutMs,
  );
  setActiveCaptureSession(session);
  installExpectScreenshotGlobal();
  installExpectScreenshotAfterGlobal();
  return () => {
    uninstallExpectScreenshotAfterGlobal();
    uninstallExpectScreenshotGlobal();
    setActiveCaptureSession(null);
  };
}

export { ScreenshotCaptureSession } from './screenshot-capture-session';
export { expectScreenshotHelper } from './expect-screenshot-runtime';
