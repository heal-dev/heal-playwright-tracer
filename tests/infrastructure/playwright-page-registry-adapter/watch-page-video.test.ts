/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import {
  PageRegistry,
  watchPageVideo,
} from '../../../src/infrastructure/playwright-page-registry-adapter';

// A page double exposing the subset watchPageVideo duck-types:
// context(), video(), on('close', …). `fireClose()` invokes the
// registered close handler.
function makePage(opts: {
  ctx?: BrowserContext;
  video?: { path: () => Promise<string> } | null;
}): Page & { fireClose: () => void } {
  const ctx = opts.ctx ?? ({} as unknown as BrowserContext);
  let closeCb: (() => void) | undefined;
  const page = {
    context: () => ctx,
    video: () => opts.video ?? null,
    on: (event: string, cb: () => void) => {
      if (event === 'close') closeCb = cb;
    },
    fireClose: () => closeCb?.(),
  };
  return page as unknown as Page & { fireClose: () => void };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('watchPageVideo', () => {
  it('resolves the video path on page close and stores it on the registry entry', async () => {
    const reg = new PageRegistry();
    const page = makePage({ video: { path: () => Promise.resolve('/out/video-abc.webm') } });
    reg.ensurePageId(page);
    watchPageVideo(reg, page);

    expect(reg.entryForPage(page)?.videoRecordingPath).toBeUndefined(); // not yet closed
    page.fireClose();
    await flush();
    expect(reg.entryForPage(page)?.videoRecordingPath).toBe('/out/video-abc.webm');
  });

  it('is a no-op for a page with no recorded video (video() returns null)', async () => {
    const reg = new PageRegistry();
    const page = makePage({ video: null });
    reg.ensurePageId(page);
    expect(() => watchPageVideo(reg, page)).not.toThrow();
    page.fireClose();
    await flush();
    expect(reg.entryForPage(page)?.videoRecordingPath).toBeUndefined();
  });

  it('is a no-op for a page double without video()/on() (does not throw)', () => {
    const reg = new PageRegistry();
    const bare = { context: () => ({}) } as unknown as Page;
    reg.ensurePageId(bare);
    expect(() => watchPageVideo(reg, bare)).not.toThrow();
  });

  it('swallows a rejected path() and leaves the entry path-less', async () => {
    const reg = new PageRegistry();
    const page = makePage({ video: { path: () => Promise.reject(new Error('discarded')) } });
    reg.ensurePageId(page);
    watchPageVideo(reg, page);
    page.fireClose();
    await flush();
    expect(reg.entryForPage(page)?.videoRecordingPath).toBeUndefined();
  });

  it('exposes a videoPathPromise at registration that resolves to the path on close', async () => {
    const reg = new PageRegistry();
    const page = makePage({ video: { path: () => Promise.resolve('/out/video-xyz.webm') } });
    reg.ensurePageId(page);
    watchPageVideo(reg, page);

    const promise = reg.entryForPage(page)?.videoPathPromise;
    expect(promise).toBeInstanceOf(Promise);
    page.fireClose();
    await expect(promise).resolves.toBe('/out/video-xyz.webm');
  });

  it('resolves videoPathPromise to null when path() rejects', async () => {
    const reg = new PageRegistry();
    const page = makePage({ video: { path: () => Promise.reject(new Error('discarded')) } });
    reg.ensurePageId(page);
    watchPageVideo(reg, page);

    const promise = reg.entryForPage(page)?.videoPathPromise;
    page.fireClose();
    await expect(promise).resolves.toBeNull();
  });

  it('does not set a videoPathPromise for a page with no recorded video', () => {
    const reg = new PageRegistry();
    const page = makePage({ video: null });
    reg.ensurePageId(page);
    watchPageVideo(reg, page);
    expect(reg.entryForPage(page)?.videoPathPromise).toBeUndefined();
  });
});
