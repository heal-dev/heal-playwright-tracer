// Capture pipeline shared by the locator action patch and the
// assertion wrapper. Owns:
//
//   - Per-session state (screenshot output directory + monotonic
//     sequence). `beginCaptureSession`/`endCaptureSession` are driven
//     by the fixture; everything else in this file reads them.
//   - `drawOverlay` / `removeOverlay` — inject and remove a single
//     absolutely-positioned <canvas> with a colored CSS border and
//     `pointer-events: none` so it never intercepts the real event.
//   - `captureWithHighlight` — the draw → screenshot → stamp pipeline
//     used by both the locator-action patch and the assertion wrapper.
//     The overlay is drawn BEFORE the screenshot so the highlight is
//     visible in the saved PNG; callers must remove it in their own
//     finally block once the action or assertion has run.
//
// The state is module-scoped because `Locator.prototype` is process-
// global, and the fixture owns exactly one active capture session at
// a time.

import * as fs from 'fs';
import * as path from 'path';
import type { CDPSession, Page } from 'playwright';
import { setCurrentStatementScreenshot } from '../../trace-event-recorder/entrypoint';

const DRAW_BORDER_SIZE = 4;
const DRAW_COLOR = 'magenta';

let currentScreenshotDir: string | null = null;
let screenshotSeq = 0;

// Per-page CDP session cache. `page.screenshot()` in headed mode forces
// the configured viewport via `Emulation.setDeviceMetricsOverride`,
// which visibly resizes the OS window on every capture. Going through a
// raw CDP `Page.captureScreenshot` skips that override entirely. On
// Firefox/WebKit `newCDPSession` throws; we cache `null` so we stop
// retrying and fall back to `page.screenshot`.
const cdpSessionCache: WeakMap<Page, CDPSession | null> = new WeakMap();

async function getCDPSession(page: Page): Promise<CDPSession | null> {
  if (cdpSessionCache.has(page)) return cdpSessionCache.get(page) ?? null;
  try {
    const ctx = typeof page.context === 'function' ? page.context() : null;
    if (!ctx || typeof ctx.newCDPSession !== 'function') {
      cdpSessionCache.set(page, null);
      return null;
    }
    const session = await ctx.newCDPSession(page);
    cdpSessionCache.set(page, session);
    return session;
  } catch (_) {
    cdpSessionCache.set(page, null);
    return null;
  }
}

async function takeScreenshot(page: Page, fullPath: string): Promise<void> {
  const cdp = await getCDPSession(page);
  if (cdp) {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await fs.promises.writeFile(fullPath, Buffer.from(data, 'base64'));
    return;
  }
  await page.screenshot({ path: fullPath });
}

export function beginCaptureSession(outputDir: string): void {
  currentScreenshotDir = outputDir;
  screenshotSeq = 0;
}

export function endCaptureSession(): void {
  currentScreenshotDir = null;
}

// Inject a bordered <canvas> overlay at `box` on the page. Factored
// out so tests can assert on the draw call without a real browser.
export async function drawOverlay(
  page: Page,
  nodeId: string,
  box: { x: number; y: number; width: number; height: number },
): Promise<void> {
  await page.evaluate(
    (params: {
      nodeId: string;
      box: { x: number; y: number; width: number; height: number };
      borderSize: number;
      color: string;
    }) => {
      const node = document.createElement('canvas');
      node.id = params.nodeId;
      node.style.pointerEvents = 'none';
      node.style.position = 'absolute';
      node.style.left = params.box.x + window.scrollX + 'px';
      node.style.top = params.box.y + window.scrollY + 'px';
      node.style.width = params.box.width + 'px';
      node.style.height = params.box.height + 'px';
      node.style.border = params.borderSize + 'px solid ' + params.color;
      node.style.zIndex = '2147483647';
      document.body.appendChild(node);
    },
    { nodeId, box, borderSize: DRAW_BORDER_SIZE, color: DRAW_COLOR },
  );
}

export async function removeOverlay(page: Page, nodeId: string): Promise<void> {
  await page.evaluate((id: string) => {
    const el = document.getElementById(id);
    if (el) el.remove();
  }, nodeId);
}

// Shared capture pipeline:
//   1. boundingBox → if null, skip (element detached / off-screen)
//   2. drawOverlay — if this throws, nothing to clean, return null
//   3. screenshot + setCurrentStatementScreenshot — overlay is already
//      drawn, so on failure we still return the nodeId so the caller
//      can clean it up in its finally block
//
// Returns the overlay node id if one is drawn (caller must call
// `removeOverlay` in finally), or null if nothing was drawn.
export async function captureWithHighlight(
  page: Page,
  target: {
    boundingBox?: () => Promise<{
      x: number;
      y: number;
      width: number;
      height: number;
    } | null>;
  },
  actionName: string,
): Promise<string | null> {
  if (!currentScreenshotDir) return null;
  if (typeof target.boundingBox !== 'function') return null;

  let box: { x: number; y: number; width: number; height: number } | null;
  try {
    box = await target.boundingBox();
  } catch (_) {
    return null;
  }
  if (!box) return null;

  const seq = ++screenshotSeq;
  const nodeId = `_heal_draw_area_tracer_${seq}`;
  try {
    await drawOverlay(page, nodeId, box);
  } catch (_) {
    return null;
  }
  try {
    const filename = `highlight-${seq}-${actionName}.png`;
    const fullPath = path.join(currentScreenshotDir, filename);
    await takeScreenshot(page, fullPath);
    setCurrentStatementScreenshot(filename);
  } catch (_) {
    // Overlay is drawn; caller must still clean it up in its finally.
  }
  return nodeId;
}
