/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// drawOverlay / removeOverlay — stateless page-side helpers used by
// the screenshot capture pipeline.
//
// They inject and remove a single absolutely-positioned <div> with
// a translucent magenta fill and `pointer-events: none` so the
// overlay never intercepts the real event targeted by the user's
// action. Factored out of the capture session so tests can assert
// on the draw call without a real browser.
//
// We use a <div> rather than a <canvas> because Playwright's trace
// viewer captures DOM snapshots: an empty <canvas> is a replaced
// element whose default bitmap is transparent, and the trace viewer
// renders that as its standard transparency-checker placeholder —
// masking the page content underneath the overlay. A <div> is not
// a replaced element, so the trace viewer composes it like any
// other transparent box and the underlying content shows through.
//
// The translucent fill (vs. a hollow border) also matches the CDP
// path's `contentColor` so the two paths produce visually similar
// traces.
//
// Both calls are wrapped in `withTimeout`. `page.evaluate` does not
// accept a timeout option directly and is auto-waited up to the
// project's `actionTimeout`; a wedged renderer (alert, JS deadlock,
// hung navigation) would otherwise let screenshot decoration
// outlast the action it is decorating.

import type { Page } from 'playwright';
import { withTimeout } from '../../util/with-timeout';

const DRAW_BORDER_SIZE = 4;
const DRAW_BORDER_COLOR = 'magenta';
// Near-invisible tint to match the CDP path's contentColor (a:0.08).
// The visible highlight is the border; the fill is just enough to
// keep the two paths visually aligned without obscuring the element.
const DRAW_FILL_COLOR = 'rgba(255, 0, 255, 0.08)';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function drawOverlay(
  page: Page,
  nodeId: string,
  box: Box,
  timeoutMs: number,
): Promise<void> {
  await withTimeout(
    page.evaluate(
      (params: {
        nodeId: string;
        box: Box;
        borderSize: number;
        borderColor: string;
        fillColor: string;
      }) => {
        const node = document.createElement('div');
        node.id = params.nodeId;
        node.style.pointerEvents = 'none';
        node.style.position = 'absolute';
        node.style.left = params.box.x + window.scrollX + 'px';
        node.style.top = params.box.y + window.scrollY + 'px';
        node.style.width = params.box.width + 'px';
        node.style.height = params.box.height + 'px';
        node.style.border = params.borderSize + 'px solid ' + params.borderColor;
        node.style.backgroundColor = params.fillColor;
        node.style.boxSizing = 'border-box';
        node.style.zIndex = '2147483647';
        document.body.appendChild(node);
      },
      {
        nodeId,
        box,
        borderSize: DRAW_BORDER_SIZE,
        borderColor: DRAW_BORDER_COLOR,
        fillColor: DRAW_FILL_COLOR,
      },
    ),
    timeoutMs,
    'drawOverlay',
  );
}

export async function removeOverlay(page: Page, nodeId: string, timeoutMs: number): Promise<void> {
  await withTimeout(
    page.evaluate((id: string) => {
      const el = document.getElementById(id);
      if (el) el.remove();
    }, nodeId),
    timeoutMs,
    'removeOverlay',
  );
}
