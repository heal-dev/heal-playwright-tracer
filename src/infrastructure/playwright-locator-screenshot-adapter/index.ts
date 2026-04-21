/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */
// Feature: locator-screenshots — highlight + screenshot capture on
// every Playwright locator action.
//
// Public API:
//   startLocatorScreenshotCapture(samplePage, outputDir, onScreenshotWritten)
//     Ensures the process-wide Locator.prototype patch is installed,
//     creates a per-test capture session, and registers it so the
//     patched methods can find it. Returns a disposer that clears
//     the active session at test teardown.
//
//   wrapExpect(expect) — wraps Playwright's `expect` so locator
//     assertions also trigger a highlight screenshot.
//
// Class / helper locations:
//   - ScreenshotCaptureSession.ts — per-test capture pipeline
//   - locator-patch.ts            — process-global prototype patch + active-session registry
//   - assertion-wrapper.ts        — `wrapExpect` for locator assertions
//   - overlay-helpers.ts          — stateless drawOverlay / removeOverlay

import type { Page } from 'playwright';
import { ensureLocatorPrototypePatched, setActiveCaptureSession } from './locator-patch';
import { ScreenshotCaptureSession } from './screenshot-capture-session';

export function startLocatorScreenshotCapture(
  samplePage: Page,
  outputDir: string,
  onScreenshotWritten: (filename: string) => void,
): () => void {
  ensureLocatorPrototypePatched(samplePage);
  const session = new ScreenshotCaptureSession(outputDir, onScreenshotWritten);
  setActiveCaptureSession(session);
  return () => setActiveCaptureSession(null);
}

export { wrapExpect } from './assertion-wrapper';
export { ScreenshotCaptureSession } from './screenshot-capture-session';
