/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 */
// drawOverlay / removeOverlay — stateless page-side helpers used by
// the screenshot capture pipeline.
//
// They inject and remove a single absolutely-positioned <canvas>
// with a colored CSS border and `pointer-events: none` so the
// overlay never intercepts the real event targeted by the user's
// action. Factored out of the capture session so tests can assert
// on the draw call without a real browser.

import type { Page } from 'playwright';

const DRAW_BORDER_SIZE = 4;
const DRAW_COLOR = 'magenta';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function drawOverlay(page: Page, nodeId: string, box: Box): Promise<void> {
  await page.evaluate(
    (params: { nodeId: string; box: Box; borderSize: number; color: string }) => {
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
