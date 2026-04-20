// Feature: locator-screenshots — highlight + screenshot capture on
// every Playwright locator action.
//
// Public API:
//   startLocatorScreenshotCapture(samplePage, outputDir) → cleanup
//     Ensures the process-wide Locator.prototype patch is installed
//     and activates a capture session pointed at `outputDir`. The
//     returned function ends the session.
//
// The actual patching logic lives in ./locator-patch.ts. After the
// PNG is written to disk, the patch calls the recorder's
// setCurrentStatementScreenshot so the filename lands directly on
// the enter event for the user statement that triggered the action.

import type { Page } from 'playwright';
import { ensureLocatorPrototypePatched } from './locator-patch';
import { beginCaptureSession, endCaptureSession } from './capture-highlight';

export function startLocatorScreenshotCapture(samplePage: Page, outputDir: string): () => void {
  ensureLocatorPrototypePatched(samplePage);
  beginCaptureSession(outputDir);
  return () => endCaptureSession();
}

export { wrapExpect } from './assertion-wrapper';
