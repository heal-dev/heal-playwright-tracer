/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect, vi } from 'vitest';
import {
  drawOverlay,
  removeOverlay,
} from '../../../src/infrastructure/playwright-locator-screenshot-adapter/overlay-helpers';
import type { Page } from 'playwright';

interface FakePage {
  evaluate: ReturnType<typeof vi.fn>;
}

function fakePage(): FakePage {
  return { evaluate: vi.fn(async () => {}) };
}

describe('overlay-helpers', () => {
  it('drawOverlay calls page.evaluate with nodeId, box, border size, and color', async () => {
    const page = fakePage();
    const box = { x: 10, y: 20, width: 30, height: 40 };

    await drawOverlay(page as unknown as Page, 'heal-overlay-1', box);

    expect(page.evaluate).toHaveBeenCalledTimes(1);
    const [fn, args] = page.evaluate.mock.calls[0];
    expect(typeof fn).toBe('function');
    expect(args).toEqual({
      nodeId: 'heal-overlay-1',
      box,
      borderSize: 4,
      color: 'magenta',
    });
  });

  it('drawOverlay payload function builds a canvas positioned at the box coordinates', async () => {
    const page = fakePage();
    const box = { x: 100, y: 200, width: 50, height: 60 };

    // Capture the page-side function so we can drive it with a DOM
    // stub — this exercises every style assignment without a real
    // browser.
    await drawOverlay(page as unknown as Page, 'id-1', box);
    const [drawFn] = page.evaluate.mock.calls[0] as [
      (p: {
        nodeId: string;
        box: { x: number; y: number; width: number; height: number };
        borderSize: number;
        color: string;
      }) => void,
      unknown,
    ];

    const appended: unknown[] = [];
    const style: Record<string, string> = {};
    const node: { id: string; style: Record<string, string> } = { id: '', style };
    const fakeDocument = {
      createElement: vi.fn(() => node),
      body: {
        appendChild: (n: unknown) => {
          appended.push(n);
        },
      },
    };
    const fakeWindow = { scrollX: 5, scrollY: 7 };

    const origDoc = (globalThis as unknown as { document?: unknown }).document;
    const origWin = (globalThis as unknown as { window?: unknown }).window;
    (globalThis as unknown as { document: unknown }).document = fakeDocument;
    (globalThis as unknown as { window: unknown }).window = fakeWindow;
    try {
      drawFn({ nodeId: 'id-1', box, borderSize: 4, color: 'magenta' });
    } finally {
      (globalThis as unknown as { document?: unknown }).document = origDoc;
      (globalThis as unknown as { window?: unknown }).window = origWin;
    }

    expect(fakeDocument.createElement).toHaveBeenCalledWith('canvas');
    expect(node.id).toBe('id-1');
    expect(style.left).toBe('105px');
    expect(style.top).toBe('207px');
    expect(style.width).toBe('50px');
    expect(style.height).toBe('60px');
    expect(style.border).toBe('4px solid magenta');
    expect(style.pointerEvents).toBe('none');
    expect(style.position).toBe('absolute');
    expect(appended).toEqual([node]);
  });

  it('removeOverlay calls page.evaluate with the node id', async () => {
    const page = fakePage();
    await removeOverlay(page as unknown as Page, 'heal-overlay-1');

    expect(page.evaluate).toHaveBeenCalledTimes(1);
    const [fn, id] = page.evaluate.mock.calls[0];
    expect(typeof fn).toBe('function');
    expect(id).toBe('heal-overlay-1');
  });

  it('removeOverlay payload removes the matching element', async () => {
    const page = fakePage();
    await removeOverlay(page as unknown as Page, 'id-1');
    const [removeFn] = page.evaluate.mock.calls[0] as [(id: string) => void, unknown];

    const removed = vi.fn();
    const fakeDocument = {
      getElementById: vi.fn(() => ({ remove: removed })),
    };
    const origDoc = (globalThis as unknown as { document?: unknown }).document;
    (globalThis as unknown as { document: unknown }).document = fakeDocument;
    try {
      removeFn('id-1');
    } finally {
      (globalThis as unknown as { document?: unknown }).document = origDoc;
    }

    expect(fakeDocument.getElementById).toHaveBeenCalledWith('id-1');
    expect(removed).toHaveBeenCalledTimes(1);
  });

  it('removeOverlay payload is a no-op when the element is not found', async () => {
    const page = fakePage();
    await removeOverlay(page as unknown as Page, 'missing');
    const [removeFn] = page.evaluate.mock.calls[0] as [(id: string) => void, unknown];

    const fakeDocument = { getElementById: vi.fn(() => null) };
    const origDoc = (globalThis as unknown as { document?: unknown }).document;
    (globalThis as unknown as { document: unknown }).document = fakeDocument;
    try {
      expect(() => removeFn('missing')).not.toThrow();
    } finally {
      (globalThis as unknown as { document?: unknown }).document = origDoc;
    }
  });
});
