/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CDPSession, Page } from 'playwright';
import { drawOverlay } from './overlay-helpers';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CapturableTarget {
  boundingBox?: () => Promise<Box | null>;
}

export class ScreenshotCaptureSession {
  private seq = 0;

  // Per-page CDP session cache. `page.screenshot()` in headed mode forces
  // the configured viewport via `Emulation.setDeviceMetricsOverride`,
  // which visibly resizes the OS window on every capture. Going through
  // a raw CDP `Page.captureScreenshot` skips that override entirely. On
  // Firefox/WebKit `newCDPSession` throws; we cache `null` so we stop
  // retrying and fall back to `page.screenshot`.
  private readonly cdpSessionCache: WeakMap<Page, CDPSession | null> = new WeakMap();

  constructor(
    private readonly outputDir: string,
    private readonly onScreenshotWritten: (filename: string) => void,
  ) {}

  // Draw → screenshot → stamp. Returns the overlay node id if one is
  // drawn (caller must call `removeOverlay` in finally), or null if
  // nothing was drawn.
  async captureWithHighlight(
    page: Page,
    target: CapturableTarget,
    actionName: string,
  ): Promise<string | null> {
    if (typeof target.boundingBox !== 'function') return null;

    let box: Box | null;
    try {
      box = await target.boundingBox();
    } catch (_) {
      return null;
    }
    if (!box) return null;

    const seq = ++this.seq;
    const nodeId = `_heal_draw_area_tracer_${seq}`;
    try {
      await drawOverlay(page, nodeId, box);
    } catch (_) {
      return null;
    }
    try {
      const filename = `highlight-${seq}-${actionName}.png`;
      const fullPath = path.join(this.outputDir, filename);
      await this.takeScreenshot(page, fullPath);
      this.onScreenshotWritten(filename);
    } catch (_) {
      // Overlay is drawn; caller must still clean it up in its finally.
    }
    return nodeId;
  }

  private async takeScreenshot(page: Page, fullPath: string): Promise<void> {
    const cdp = await this.getCDPSession(page);
    if (cdp) {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      await fs.promises.writeFile(fullPath, Buffer.from(data, 'base64'));
      return;
    }
    await page.screenshot({ path: fullPath });
  }

  private async getCDPSession(page: Page): Promise<CDPSession | null> {
    if (this.cdpSessionCache.has(page)) return this.cdpSessionCache.get(page) ?? null;
    try {
      const ctx = typeof page.context === 'function' ? page.context() : null;
      if (!ctx || typeof ctx.newCDPSession !== 'function') {
        this.cdpSessionCache.set(page, null);
        return null;
      }
      const session = await ctx.newCDPSession(page);
      this.cdpSessionCache.set(page, session);
      return session;
    } catch (_) {
      this.cdpSessionCache.set(page, null);
      return null;
    }
  }
}
