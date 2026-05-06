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
// On Chromium the highlight is drawn natively via CDP
// `Overlay.highlightNode`, so the box is composed by the renderer at
// rasterize time using the element's *current* layout — there is no
// JS-side coordinate that can go stale between measurement and the
// screenshot. On Firefox/WebKit (no CDP) we fall back to the JS
// canvas overlay in `overlay-helpers.ts`; that path measures coords
// with `boundingBox()` and is subject to layout shifts between
// measure and screenshot.
//
// Every async this session awaits is capped at `screenshotTimeoutMs`
// — `boundingBox`, `locator.evaluate` (stash/unstash), every CDP
// `send`, `newCDPSession`, the `page.screenshot` fallback, and the
// JS overlay's `page.evaluate`. Decoration must always fail-fast:
// the user's actionTimeout governs the action, this timeout governs
// the tracer.

import * as fs from 'fs';
import * as path from 'path';
import type { CDPSession, Page } from 'playwright';
import { drawOverlay, removeOverlay } from './overlay-helpers';
import { withTimeout } from '../../util/with-timeout';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CapturableTarget {
  boundingBox?: (options?: { timeout?: number }) => Promise<Box | null>;
  evaluate?: <R, A>(
    fn: (el: Element, arg: A) => R,
    arg: A,
    options?: { timeout?: number },
  ) => Promise<R>;
  scrollIntoViewIfNeeded?: (options?: { timeout?: number }) => Promise<void>;
}

type EvaluatableTarget = CapturableTarget & {
  evaluate: NonNullable<CapturableTarget['evaluate']>;
};

function hasEvaluate(target: CapturableTarget): target is EvaluatableTarget {
  return typeof target.evaluate === 'function';
}

// 'action' — Playwright's actions auto-scroll the target into view as
//   part of actionability. We mirror that here so the screenshot
//   matches what the user will see when the action runs.
// 'assertion' — locator assertions (`toBeVisible`, `toBeInViewport`,
//   etc.) do NOT auto-scroll, and viewport-sensitive assertions would
//   change outcome if we did. We capture beyond the viewport instead
//   so off-viewport targets are still visible in the screenshot.
export type CaptureMode = 'action' | 'assertion';

// CDP HighlightConfig — near-invisible magenta tint over the
// element's content box. `Overlay.highlightNode` is a fill-based
// primitive (no native outline mode), so we drop the alpha to ~0.08
// to keep the highlight reading visually as a border-only frame
// while preserving the rasterize-time composition that gives the
// CDP path its layout-shift immunity. Padding/border/margin
// regions stay fully transparent. `showInfo`/`showRulers`/
// `showExtensionLines` off — we don't want the DevTools-style
// breakdown labels.
const HIGHLIGHT_CONFIG = {
  contentColor: { r: 255, g: 0, b: 255, a: 0.08 },
  paddingColor: { r: 0, g: 0, b: 0, a: 0 },
  borderColor: { r: 0, g: 0, b: 0, a: 0 },
  marginColor: { r: 0, g: 0, b: 0, a: 0 },
  showInfo: false,
  showRulers: false,
  showExtensionLines: false,
};

// Page-side namespace for CDP-path stash entries. We park the live
// element under `window[STASH_NAMESPACE][key]` so a CDP
// `Runtime.evaluate` can resolve it to an objectId without us having
// to reach into Playwright's private handle internals.
const STASH_NAMESPACE = '__heal_overlay_stash';

export class ScreenshotCaptureSession {
  private seq = 0;

  // Per-page CDP session cache. `page.screenshot()` in headed mode forces
  // the configured viewport via `Emulation.setDeviceMetricsOverride`,
  // which visibly resizes the OS window on every capture. Going through
  // a raw CDP `Page.captureScreenshot` skips that override entirely. On
  // Firefox/WebKit `newCDPSession` throws; we cache `null` so we stop
  // retrying and fall back to `page.screenshot`.
  private readonly cdpSessionCache: WeakMap<Page, CDPSession | null> = new WeakMap();

  // `Overlay.enable` is a one-time per-session call. Memoize so we
  // don't pay for it on every action.
  private readonly overlayEnabled: WeakSet<CDPSession> = new WeakSet();

  constructor(
    private readonly outputDir: string,
    private readonly onScreenshotWritten: (filename: string) => void,
    private readonly screenshotTimeoutMs: number,
  ) {}

  // Returns a cleanup closure to call after the action completes
  // (caller invokes it in `finally`), or `null` if no cleanup is
  // needed (CDP path cleans up internally before returning;
  // capture-not-attempted cases also return `null`).
  async captureWithHighlight(
    page: Page,
    target: CapturableTarget,
    actionName: string,
    options: { mode: CaptureMode },
  ): Promise<(() => Promise<void>) | null> {
    if (options.mode === 'action' && typeof target.scrollIntoViewIfNeeded === 'function') {
      try {
        await target.scrollIntoViewIfNeeded({ timeout: this.screenshotTimeoutMs });
      } catch (_) {
        // Best-effort. If this fails, the existing measure-or-fallback
        // path handles missing/detached targets.
      }
    }

    const fullPage = options.mode === 'assertion';
    const cdp = await this.getCDPSession(page);

    if (cdp && hasEvaluate(target)) {
      const seq = ++this.seq;
      const filename = `highlight-${seq}-${actionName}.png`;
      const fullPath = path.join(this.outputDir, filename);
      try {
        await this.captureViaCdpHighlight(cdp, target, seq, fullPath, fullPage);
        this.onScreenshotWritten(filename);
        return null;
      } catch (_) {
        // CDP path failed mid-flight — drop down to the JS overlay
        // with the seq we already burned to keep numbering stable
        // and reuse the same filename.
        return this.captureViaJsOverlayReusingSeq(page, target, seq, fullPath, filename, fullPage);
      }
    }

    return this.captureViaJsOverlay(page, target, actionName, fullPage);
  }

  private async captureViaCdpHighlight(
    cdp: CDPSession,
    target: EvaluatableTarget,
    seq: number,
    fullPath: string,
    fullPage: boolean,
  ): Promise<void> {
    const stashKey = `seq_${seq}`;

    // 1. Stash the live element on the page-side namespace so we
    //    have a stable identity to resolve via Runtime.evaluate.
    await target.evaluate(
      (el: Element, params: { ns: string; key: string }) => {
        const w = window as unknown as { [k: string]: { [k: string]: Element } };
        if (!w[params.ns]) w[params.ns] = {};
        w[params.ns][params.key] = el;
      },
      { ns: STASH_NAMESPACE, key: stashKey },
      { timeout: this.screenshotTimeoutMs },
    );

    let objectId: string | undefined;
    try {
      // 2. Resolve the stashed reference to a Runtime objectId.
      const evalResp = (await this.cdpSend(cdp, 'Runtime.evaluate', {
        expression: `window.${STASH_NAMESPACE}[${JSON.stringify(stashKey)}]`,
      })) as { result?: { objectId?: string } };
      objectId = evalResp.result?.objectId;
      if (!objectId) throw new Error('failed to resolve stashed element');

      // 3. Convert objectId → CDP nodeId.
      const reqResp = (await this.cdpSend(cdp, 'DOM.requestNode', { objectId })) as {
        nodeId?: number;
      };
      const nodeId = reqResp.nodeId;
      if (!nodeId) throw new Error('failed to resolve nodeId');

      // 4. Highlight, screenshot, hide. The renderer composes the
      //    highlight with the element's live layout box, so the box
      //    can't be stale.
      if (!this.overlayEnabled.has(cdp)) {
        await this.cdpSend(cdp, 'Overlay.enable');
        this.overlayEnabled.add(cdp);
      }
      await this.cdpSend(cdp, 'Overlay.highlightNode', {
        highlightConfig: HIGHLIGHT_CONFIG,
        nodeId,
      });
      try {
        const screenshotParams: Record<string, unknown> = { format: 'png' };
        if (fullPage) screenshotParams.captureBeyondViewport = true;
        const shotResp = (await this.cdpSend(cdp, 'Page.captureScreenshot', screenshotParams)) as {
          data: string;
        };
        await fs.promises.writeFile(fullPath, Buffer.from(shotResp.data, 'base64'));
      } finally {
        try {
          await this.cdpSend(cdp, 'Overlay.hideHighlight');
        } catch (_) {
          // Hiding is best-effort; the next highlight call replaces it.
        }
      }
    } finally {
      // 5. Cleanup: drop the stash entry and release the remote object.
      if (objectId) {
        try {
          await this.cdpSend(cdp, 'Runtime.releaseObject', { objectId });
        } catch (_) {
          // Released with the page; nothing to do.
        }
      }
      try {
        await target.evaluate(
          (_el: Element, params: { ns: string; key: string }) => {
            const w = window as unknown as {
              [k: string]: { [k: string]: Element } | undefined;
            };
            const ns = w[params.ns];
            if (ns) delete ns[params.key];
          },
          { ns: STASH_NAMESPACE, key: stashKey },
          { timeout: this.screenshotTimeoutMs },
        );
      } catch (_) {
        // Page detached / navigated — the stash will be GC'd with
        // the page.
      }
    }
  }

  private async captureViaJsOverlay(
    page: Page,
    target: CapturableTarget,
    actionName: string,
    fullPage: boolean,
  ): Promise<(() => Promise<void>) | null> {
    const box = await this.measureBox(target);
    if (!box) return null;

    const seq = ++this.seq;
    const filename = `highlight-${seq}-${actionName}.png`;
    const fullPath = path.join(this.outputDir, filename);
    return this.drawAndScreenshotJs(page, seq, box, filename, fullPath, fullPage);
  }

  // Used when the CDP path failed *after* `seq` was already
  // incremented. Re-measures the box (it may have moved since CDP
  // started) and reuses the original filename so per-statement
  // numbering stays continuous.
  private async captureViaJsOverlayReusingSeq(
    page: Page,
    target: CapturableTarget,
    seq: number,
    fullPath: string,
    filename: string,
    fullPage: boolean,
  ): Promise<(() => Promise<void>) | null> {
    const box = await this.measureBox(target);
    if (!box) return null;
    return this.drawAndScreenshotJs(page, seq, box, filename, fullPath, fullPage);
  }

  private async measureBox(target: CapturableTarget): Promise<Box | null> {
    if (typeof target.boundingBox !== 'function') return null;
    try {
      return await target.boundingBox({ timeout: this.screenshotTimeoutMs });
    } catch (_) {
      return null;
    }
  }

  private async drawAndScreenshotJs(
    page: Page,
    seq: number,
    box: Box,
    filename: string,
    fullPath: string,
    fullPage: boolean,
  ): Promise<(() => Promise<void>) | null> {
    const nodeId = `_heal_draw_area_tracer_${seq}`;
    try {
      await drawOverlay(page, nodeId, box, this.screenshotTimeoutMs);
    } catch (_) {
      return null;
    }
    try {
      await this.takeScreenshot(page, fullPath, fullPage);
      this.onScreenshotWritten(filename);
    } catch (_) {
      // Overlay drawn; the cleanup closure below still removes it.
    }
    return () => removeOverlay(page, nodeId, this.screenshotTimeoutMs);
  }

  private async takeScreenshot(page: Page, fullPath: string, fullPage: boolean): Promise<void> {
    const cdp = await this.getCDPSession(page);
    if (cdp) {
      const screenshotParams: Record<string, unknown> = { format: 'png' };
      if (fullPage) screenshotParams.captureBeyondViewport = true;
      const shotResp = (await this.cdpSend(cdp, 'Page.captureScreenshot', screenshotParams)) as {
        data: string;
      };
      await fs.promises.writeFile(fullPath, Buffer.from(shotResp.data, 'base64'));
      return;
    }
    await page.screenshot({ path: fullPath, timeout: this.screenshotTimeoutMs, fullPage });
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
    } catch (_) {
      this.cdpSessionCache.set(page, null);
      return null;
    }
  }
}
