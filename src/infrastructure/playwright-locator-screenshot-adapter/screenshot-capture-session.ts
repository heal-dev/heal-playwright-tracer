/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// ScreenshotCaptureSession — one test's worth of locator-screenshot
// capture: output directory, monotonic per-test sequence, CDP cache,
// the callback that stamps the filename onto the active statement,
// and the best-effort timeout that caps every async the session
// awaits. The fixture creates one at test start and drops it at
// test teardown (via `setActiveCaptureSession`).
//
// One unified flow on every browser:
//   1. (optional) `scrollIntoViewIfNeeded` — caller-controlled via
//      `scrollBeforeCapture`. Locator actions always scroll (mirrors
//      Playwright's own actionability auto-scroll). Locator assertions
//      scroll too, except for `toBeInViewport` / `not.toBeInViewport`
//      where the wrapper opts out so it doesn't change the assertion
//      outcome.
//   2. Wait for the page to visually settle — `document.fonts.ready`
//      plus two animation frames so at least one full layout+paint
//      cycle has completed since the scroll. Deliberately NOT
//      `networkidle`: SPAs that poll or hold a websocket never reach
//      it, so it would burn the whole `screenshotTimeoutMs` on every
//      capture. Best-effort like everything else here.
//   3. Measure the target's `boundingBox`.
//   4. Inject a `<div>` overlay at the target's document position
//      (4px magenta border + faint translucent fill). See
//      `overlay-helpers.ts` for the page-side draw/remove pair.
//   5. Take a viewport screenshot — via CDP `Page.captureScreenshot`
//      when available (Chromium; avoids the headed-mode
//      `Emulation.setDeviceMetricsOverride` resize that
//      `page.screenshot` triggers), else `page.screenshot` fallback
//      (Firefox/WebKit).
//   6. Return a cleanup closure that removes the overlay after the
//      caller's action/assertion completes.
//
// CDP `Overlay.highlightNode` is *not* used. It paints box-model
// regions with colors and has no native "outline around the
// element" mode, so the highlight is invisible on elements without
// a CSS border at our chosen translucent alpha. Going through the
// `<div>` overlay produces a visible frame on every browser without
// caring about the element's CSS.
//
// Every async this session awaits is capped at `screenshotTimeoutMs`
// — `scrollIntoViewIfNeeded`, the visual-settle `page.evaluate`,
// `boundingBox`, every CDP `send`, `newCDPSession`, the
// `page.screenshot` fallback, and the overlay's `page.evaluate`
// (draw / remove). Decoration must
// always fail-fast: the user's actionTimeout governs the action,
// this timeout governs the tracer.

import * as fs from 'fs';
import * as path from 'path';
import type { CDPSession, Page } from 'playwright';
import { drawOverlay, removeOverlay } from './overlay-helpers';
import { withTimeout } from '../../util/with-timeout';
import { log } from '../../util/logger';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CapturableTarget {
  boundingBox?: (options?: { timeout?: number }) => Promise<Box | null>;
  scrollIntoViewIfNeeded?: (options?: { timeout?: number }) => Promise<void>;
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
    private readonly onRawScreenshotWritten: (filename: string) => void,
    private readonly screenshotTimeoutMs: number,
  ) {}

  // Plain viewport screenshot — no overlay, no measure, no scroll.
  // Used by the expect-screenshot helper when the asserted locator
  // matches zero elements (typical for `toHaveCount(0)`, `toBeHidden()`,
  // `.not.toBeVisible()`): there's nothing to frame, but the user
  // still benefits from seeing the page state at the assertion.
  // Increments the same `seq` counter and writes to the same
  // `highlight-${seq}-${actionName}.png` filename as the highlight
  // path so screenshots stay numbered consistently within a test.
  async captureViewportOnly(page: Page, actionName: string): Promise<void> {
    const seq = ++this.seq;
    const filename = `highlight-${seq}-${actionName}.png`;
    const fullPath = path.join(this.outputDir, filename);
    try {
      await this.takeScreenshot(page, fullPath);
      this.onScreenshotWritten(filename);
    } catch (err) {
      log.warn(`captureViewportOnly takeScreenshot rejected for ${actionName}`, err);
    }
  }

  // Returns a cleanup closure to call after the action/assertion
  // completes (caller invokes it in `finally`), or `null` if no
  // cleanup is needed (capture-not-attempted cases).
  async captureWithHighlight(
    page: Page,
    target: CapturableTarget,
    actionName: string,
    options: { scrollBeforeCapture: boolean; alsoRaw?: boolean },
  ): Promise<(() => Promise<void>) | null> {
    if (options.scrollBeforeCapture && typeof target.scrollIntoViewIfNeeded === 'function') {
      try {
        await target.scrollIntoViewIfNeeded({ timeout: this.screenshotTimeoutMs });
      } catch (err) {
        // Best-effort. If this fails, the target may be off-viewport
        // in the screenshot — but Playwright's own actionability
        // check still runs against the user's full actionTimeout
        // when the action proceeds, so the test is unaffected.
        log.warn(`scrollIntoViewIfNeeded failed before ${actionName} screenshot`, err);
      }
    }

    await this.waitForPageIdle(page);

    const box = await this.measureBox(target);
    if (!box) return null;

    const seq = ++this.seq;
    // Action path: also write the same settled frame WITHOUT the overlay
    // into `raw/`, sharing this seq so the highlight/raw pair line up.
    // Done before `drawAndScreenshot` draws the box, so the raw frame is
    // clean. (Assertions don't set this — their clean frame is the
    // after-snap; the pre-snap here would be the pre-matcher loading frame.)
    if (options.alsoRaw) {
      await this.writeRaw(page, actionName, seq);
    }
    const filename = `highlight-${seq}-${actionName}.png`;
    const fullPath = path.join(this.outputDir, filename);
    return this.drawAndScreenshot(page, seq, box, filename, fullPath);
  }

  // Overlay-free capture used by the expect-screenshot AFTER-helper:
  // once an assertion's matcher has passed, snap the now-settled page
  // (no highlight box) into the `raw/` subfolder. Same scroll + idle
  // gate as the highlight path, but no measure / overlay / cleanup —
  // the frame is the clean page the visual-defect detector consumes.
  async captureRaw(
    page: Page,
    target: CapturableTarget,
    actionName: string,
    options: { scrollBeforeCapture: boolean },
  ): Promise<void> {
    if (options.scrollBeforeCapture && typeof target.scrollIntoViewIfNeeded === 'function') {
      try {
        await target.scrollIntoViewIfNeeded({ timeout: this.screenshotTimeoutMs });
      } catch (err) {
        log.warn(`scrollIntoViewIfNeeded failed before ${actionName} raw screenshot`, err);
      }
    }
    await this.waitForPageIdle(page);
    await this.writeRaw(page, actionName);
  }

  // Raw counterpart of `captureViewportOnly` for the count===0
  // assertion case (`toBeHidden()`, `.not.toBeVisible()`): nothing to
  // frame, but the settled page is still worth a clean frame.
  async captureRawViewportOnly(page: Page, actionName: string): Promise<void> {
    await this.waitForPageIdle(page);
    await this.writeRaw(page, actionName);
  }

  private async writeRaw(page: Page, actionName: string, seq: number = ++this.seq): Promise<void> {
    const filename = `raw-${seq}-${actionName}.png`;
    const rawDir = path.join(this.outputDir, 'raw');
    try {
      await fs.promises.mkdir(rawDir, { recursive: true });
      await this.takeScreenshot(page, path.join(rawDir, filename));
      this.onRawScreenshotWritten(filename);
    } catch (err) {
      log.warn(`writeRaw takeScreenshot rejected for ${actionName}`, err);
    }
  }

  // Best-effort "page is visually settled" gate, run after the
  // optional scroll and before we measure/draw/screenshot. Waits for
  // web fonts to finish loading and for two animation frames to pass,
  // so at least one full layout+paint cycle has completed since the
  // scroll (lazy content, reflow, transitions kicked off by the
  // scroll have had a frame to land). `requestAnimationFrame` is
  // double-nested because the first callback fires *before* the
  // ensuing paint; the second guarantees that paint has happened.
  // Swallowed + capped like every other async here so a wedged
  // renderer can never block the user's action.
  private async waitForPageIdle(page: Page): Promise<void> {
    try {
      await withTimeout(
        page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              const settle = () =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
              if (document.fonts) {
                document.fonts.ready.then(settle, settle);
              } else {
                settle();
              }
            }),
        ),
        this.screenshotTimeoutMs,
        'waitForPageIdle',
      );
    } catch (err) {
      log.warn('waitForPageIdle did not settle before screenshot', err);
    }
  }

  private async measureBox(target: CapturableTarget): Promise<Box | null> {
    if (typeof target.boundingBox !== 'function') return null;
    try {
      return await target.boundingBox({ timeout: this.screenshotTimeoutMs });
    } catch (err) {
      log.warn('measureBox boundingBox threw — skipping highlight overlay', err);
      return null;
    }
  }

  private async drawAndScreenshot(
    page: Page,
    seq: number,
    box: Box,
    filename: string,
    fullPath: string,
  ): Promise<(() => Promise<void>) | null> {
    const nodeId = `_heal_draw_area_tracer_${seq}`;
    try {
      await drawOverlay(page, nodeId, box, this.screenshotTimeoutMs);
    } catch (err) {
      log.warn('drawOverlay threw — skipping highlight screenshot', err);
      return null;
    }
    try {
      await this.takeScreenshot(page, fullPath);
      this.onScreenshotWritten(filename);
    } catch (err) {
      // Overlay drawn; the cleanup closure below still removes it.
      log.warn('takeScreenshot threw after overlay was drawn', err);
    }
    return () => removeOverlay(page, nodeId, this.screenshotTimeoutMs);
  }

  private async takeScreenshot(page: Page, fullPath: string): Promise<void> {
    const cdp = await this.getCDPSession(page);
    if (cdp) {
      const shotResp = (await this.cdpSend(cdp, 'Page.captureScreenshot', {
        format: 'png',
      })) as { data: string };
      await fs.promises.writeFile(fullPath, Buffer.from(shotResp.data, 'base64'));
      return;
    }
    await page.screenshot({ path: fullPath, timeout: this.screenshotTimeoutMs });
  }

  // Promise.race wrapper around `cdp.send`. CDP itself has no
  // protocol-level timeout; a wedged renderer or unhandled `alert()`
  // would otherwise block forever. Returns `unknown` because
  // CDPSession.send is overloaded per-command and cannot be wrapped
  // generically without losing the per-command return shape — call
  // sites that need typed fields cast.
  private cdpSend(cdp: CDPSession, method: string, params?: object): Promise<unknown> {
    return withTimeout(
      (cdp.send as (m: string, p?: object) => Promise<unknown>).call(cdp, method, params),
      this.screenshotTimeoutMs,
      `cdp.send(${method})`,
    );
  }

  private async getCDPSession(page: Page): Promise<CDPSession | null> {
    if (this.cdpSessionCache.has(page)) return this.cdpSessionCache.get(page) ?? null;
    try {
      const ctx = typeof page.context === 'function' ? page.context() : null;
      if (!ctx || typeof ctx.newCDPSession !== 'function') {
        this.cdpSessionCache.set(page, null);
        return null;
      }
      const session = await withTimeout(
        ctx.newCDPSession(page),
        this.screenshotTimeoutMs,
        'newCDPSession',
      );
      this.cdpSessionCache.set(page, session);
      return session;
    } catch (err) {
      log.warn('newCDPSession failed; falling back to page.screenshot for this page', err);
      this.cdpSessionCache.set(page, null);
      return null;
    }
  }
}
