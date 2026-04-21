/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */

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
