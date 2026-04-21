/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

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
