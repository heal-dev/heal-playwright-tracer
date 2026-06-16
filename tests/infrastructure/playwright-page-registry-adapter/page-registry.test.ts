/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import { PageRegistry } from '../../../src/infrastructure/playwright-page-registry-adapter';

// Minimal Page/BrowserContext doubles: a page only needs context();
// a context is an opaque identity object.
function makeContext(): BrowserContext {
  return {} as unknown as BrowserContext;
}
function makePage(ctx: BrowserContext): Page {
  return { context: () => ctx } as unknown as Page;
}

describe('PageRegistry', () => {
  it('assigns the first page ctx0/p0', () => {
    const reg = new PageRegistry();
    const ctx = makeContext();
    expect(reg.ensurePageId(makePage(ctx))).toBe('ctx0/p0');
  });

  it('numbers pages within a context p0, p1, p2 …', () => {
    const reg = new PageRegistry();
    const ctx = makeContext();
    expect(reg.ensurePageId(makePage(ctx))).toBe('ctx0/p0');
    expect(reg.ensurePageId(makePage(ctx))).toBe('ctx0/p1');
    expect(reg.ensurePageId(makePage(ctx))).toBe('ctx0/p2');
  });

  it('numbers contexts ctx0, ctx1 … in first-seen order', () => {
    const reg = new PageRegistry();
    const ctxA = makeContext();
    const ctxB = makeContext();
    expect(reg.ensurePageId(makePage(ctxA))).toBe('ctx0/p0');
    expect(reg.ensurePageId(makePage(ctxB))).toBe('ctx1/p0');
    // A second page back in ctxA keeps ctx0 and increments its page index.
    expect(reg.ensurePageId(makePage(ctxA))).toBe('ctx0/p1');
  });

  it('returns a stable id for the same page on repeated calls', () => {
    const reg = new PageRegistry();
    const page = makePage(makeContext());
    const first = reg.ensurePageId(page);
    expect(reg.ensurePageId(page)).toBe(first);
    expect(reg.idForPage(page)).toBe(first);
  });

  it('idForPage returns undefined for an unseen page', () => {
    const reg = new PageRegistry();
    expect(reg.idForPage(makePage(makeContext()))).toBeUndefined();
  });

  it('ensureContextId is stable and consistent with page ids', () => {
    const reg = new PageRegistry();
    const ctx = makeContext();
    const ctxId = reg.ensureContextId(ctx);
    expect(ctxId).toBe('ctx0');
    expect(reg.ensureContextId(ctx)).toBe('ctx0');
    expect(reg.ensurePageId(makePage(ctx))).toBe('ctx0/p0');
  });

  it('list() returns every registered page in registration order', () => {
    const reg = new PageRegistry();
    const ctx = makeContext();
    const p0 = makePage(ctx);
    const p1 = makePage(ctx);
    reg.ensurePageId(p0);
    reg.ensurePageId(p1);
    const ids = reg.list().map((e) => e.pageId);
    expect(ids).toEqual(['ctx0/p0', 'ctx0/p1']);
    expect(reg.list().map((e) => e.page)).toEqual([p0, p1]);
  });

  it('setVideoPathPromise stores the promise on the entry; resolves to the path', async () => {
    const reg = new PageRegistry();
    const page = makePage(makeContext());
    reg.ensurePageId(page);
    expect(reg.entryForPage(page)?.videoPathPromise).toBeUndefined();

    const promise = Promise.resolve('/rec/video.webm');
    reg.setVideoPathPromise(page, promise);
    expect(reg.entryForPage(page)?.videoPathPromise).toBe(promise);
    await expect(reg.entryForPage(page)?.videoPathPromise).resolves.toBe('/rec/video.webm');
  });

  it('setVideoPathPromise is a no-op for an unregistered page', () => {
    const reg = new PageRegistry();
    const page = makePage(makeContext()); // never ensurePageId'd
    expect(() => reg.setVideoPathPromise(page, Promise.resolve(null))).not.toThrow();
    expect(reg.entryForPage(page)).toBeUndefined();
  });

  it('stamps videoStartWallMs from the injected clock at registration time', () => {
    let t = 1_000;
    const reg = new PageRegistry(() => t);
    const a = makePage(makeContext());
    reg.ensurePageId(a);
    t = 5_000;
    const b = makePage(makeContext());
    reg.ensurePageId(b);
    // Re-registering a does not move its anchor.
    t = 9_000;
    reg.ensurePageId(a);

    expect(reg.entryForPage(a)?.videoStartWallMs).toBe(1_000);
    expect(reg.entryForPage(b)?.videoStartWallMs).toBe(5_000);
  });
});
