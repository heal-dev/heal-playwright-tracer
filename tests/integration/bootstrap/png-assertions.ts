/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Region-based pixel assertions for the screenshot-visual integration
// tests. We deliberately avoid full-frame baseline diffs: the magenta
// border sits over arbitrary page content and antialiasing varies
// across OSes, so byte-equality baselines are notoriously flaky in CI.
// Sampling pixels at known coordinates is robust and lets us assert
// the things we actually care about — "is the magenta box where the
// locator was?", "did the page scroll?", "is the box NOT in the PNG?".
//
// Tolerance: the overlay border is a 4px solid `magenta`
// (#FF00FF). Antialiasing softens the outermost row/column of the
// border, so we sample 1–2 pixels INSIDE the nominal border edge to
// avoid sampling the AA halo. Tolerance is generous in absolute RGB
// distance (DEFAULT_COLOR_TOLERANCE) — magenta is far from any neutral
// page-content color, so a loose threshold doesn't hide regressions.

import * as fs from 'fs';
import { PNG } from 'pngjs';
import { expect } from 'vitest';

export interface DecodedPng {
  width: number;
  height: number;
  data: Buffer; // RGBA, row-major
}

export function decodePng(filePath: string): DecodedPng {
  const buf = fs.readFileSync(filePath);
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: png.data };
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const MAGENTA: Rgb = { r: 255, g: 0, b: 255 };
const DEFAULT_COLOR_TOLERANCE = 60; // L2 distance in RGB space

function pixelAt(png: DecodedPng, x: number, y: number): Rgb {
  const i = (y * png.width + x) * 4;
  return { r: png.data[i], g: png.data[i + 1], b: png.data[i + 2] };
}

function colorDistance(a: Rgb, b: Rgb): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function isMagenta(rgb: Rgb, tolerance = DEFAULT_COLOR_TOLERANCE): boolean {
  return colorDistance(rgb, MAGENTA) <= tolerance;
}

/**
 * Assert the PNG carries a magenta-border overlay around the given
 * viewport box. Samples a handful of pixels along each edge — top,
 * bottom, left, right — 2px inside the nominal border to clear the
 * antialiased outer row.
 */
export function expectMagentaBorderAt(png: DecodedPng, box: Box): void {
  const samples: Array<{ label: string; x: number; y: number }> = [];

  // Top edge — 2px below the top of the box, every quarter of the width.
  for (const frac of [0.25, 0.5, 0.75]) {
    samples.push({
      label: `top@${frac}`,
      x: Math.round(box.x + box.width * frac),
      y: box.y + 2,
    });
  }
  // Bottom edge — 2px above the bottom.
  for (const frac of [0.25, 0.5, 0.75]) {
    samples.push({
      label: `bottom@${frac}`,
      x: Math.round(box.x + box.width * frac),
      y: box.y + box.height - 3,
    });
  }
  // Left edge — 2px right of the left.
  for (const frac of [0.25, 0.5, 0.75]) {
    samples.push({
      label: `left@${frac}`,
      x: box.x + 2,
      y: Math.round(box.y + box.height * frac),
    });
  }
  // Right edge — 2px left of the right.
  for (const frac of [0.25, 0.5, 0.75]) {
    samples.push({
      label: `right@${frac}`,
      x: box.x + box.width - 3,
      y: Math.round(box.y + box.height * frac),
    });
  }

  for (const s of samples) {
    if (s.x < 0 || s.x >= png.width || s.y < 0 || s.y >= png.height) {
      throw new Error(
        `expectMagentaBorderAt: sample ${s.label} (${s.x},${s.y}) is outside ` +
          `PNG bounds ${png.width}×${png.height}`,
      );
    }
    const rgb = pixelAt(png, s.x, s.y);
    expect(
      isMagenta(rgb),
      `expected magenta at ${s.label} (${s.x},${s.y}); got rgb(${rgb.r},${rgb.g},${rgb.b})`,
    ).toBe(true);
  }
}

/**
 * Assert that no magenta-colored pixels appear within the given box.
 * Used by case 6 (`toBeInViewport` on an off-viewport target):
 * the overlay sits in the DOM at its document position, but the
 * captured viewport is at the page's current scroll, so the
 * captured PNG should contain no magenta.
 */
export function expectNoMagentaInBox(png: DecodedPng, box: Box): void {
  for (let y = box.y; y < box.y + box.height; y += 4) {
    for (let x = box.x; x < box.x + box.width; x += 4) {
      if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
      const rgb = pixelAt(png, x, y);
      if (isMagenta(rgb, 30)) {
        throw new Error(
          `expectNoMagentaInBox: unexpected magenta at (${x},${y}); ` +
            `got rgb(${rgb.r},${rgb.g},${rgb.b})`,
        );
      }
    }
  }
}

/**
 * Assert the PNG is exactly the configured viewport size — confirms
 * the CDP `Page.captureScreenshot` (or `page.screenshot`) didn't
 * resize the device viewport mid-capture.
 */
export function expectViewportSize(png: DecodedPng, width: number, height: number): void {
  expect(png.width).toBe(width);
  expect(png.height).toBe(height);
}

/**
 * Walk every pixel and return the inclusive bounding box of all
 * magenta-ish pixels. Returns `null` when no pixel matches.
 *
 * Used by post-scroll cases (action click / `toBeVisible` on an
 * off-viewport target): the page scrolled before capture, so the
 * overlay's exact viewport coordinates aren't predictable, but its
 * *size* is. Caller asserts the resulting box's width/height match
 * the locator's CSS dimensions within antialiasing tolerance.
 */
export function findMagentaBoundingBox(png: DecodedPng): Box | null {
  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (isMagenta(pixelAt(png, x, y), 30)) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}
