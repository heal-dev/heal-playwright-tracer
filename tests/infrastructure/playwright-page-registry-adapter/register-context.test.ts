/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import {
  PageRegistry,
  registerContext,
} from '../../../src/infrastructure/playwright-page-registry-adapter';

// A BrowserContext double with pages() and a hand-rolled `page` event.
// `addPage` creates a page bound to this context; `emitPage` fires the
// event the way Playwright does for a popup or a new window.
function makeContext(opts: { pagesThrow?: boolean } = {}) {
  const pages: Page[] = [];
  const listeners: Array<(p: Page) => void> = [];
  const ctx = {
    pages: () => {
      if (opts.pagesThrow) throw new Error('context has been closed');
      return pages.slice();
    },
    on: (event: string, cb: (p: Page) => void) => {
      if (event === 'page') listeners.push(cb);
      return ctx;
    },
  } as unknown as BrowserContext;
  const addPage = (page: Partial<Page> = {}): Page => {
    const p = { ...page, context: () => ctx } as unknown as Page;
    pages.push(p);
    return p;
  };
  return {
    ctx,
    addPage,
    emitPage: (p: Page) => listeners.forEach((l) => l(p)),
    listenerCount: () => listeners.length,
  };
}

describe('registerContext', () => {
  it('registers the pages the context already has, in order', () => {
    const reg = new PageRegistry();
    const { ctx, addPage } = makeContext();
    const first = addPage();
    const second = addPage();

    registerContext(reg, ctx);

    expect(reg.idForPage(first)).toBe('ctx0/p0');
    expect(reg.idForPage(second)).toBe('ctx0/p1');
  });

  it('registers a page the context opens later, through its page event', () => {
    const reg = new PageRegistry();
    const { ctx, addPage, emitPage } = makeContext();
    registerContext(reg, ctx);

    const later = addPage();
    emitPage(later);

    expect(reg.idForPage(later)).toBe('ctx0/p0');
  });

  it('gives the context an id even before it has a page', () => {
    const reg = new PageRegistry();
    const { ctx } = makeContext();
    registerContext(reg, ctx);
    expect(reg.ensureContextId(ctx)).toBe('ctx0');
  });

  it('watches the video of a page that records one', async () => {
    const reg = new PageRegistry();
    const { ctx, addPage } = makeContext();
    let onClose: (() => void) | undefined;
    const page = addPage({
      video: () => ({ path: () => Promise.resolve('/rec/win.webm') }),
      on: (event: string, cb: () => void) => {
        if (event === 'close') onClose = cb;
      },
    } as unknown as Partial<Page>);

    registerContext(reg, ctx);
    expect(reg.entryForPage(page)?.videoPathPromise).toBeDefined();

    onClose?.();
    await expect(reg.entryForPage(page)?.videoPathPromise).resolves.toBe('/rec/win.webm');
    expect(reg.entryForPage(page)?.videoRecordingPath).toBe('/rec/win.webm');
  });

  it('swallows a context whose pages() throws (already closed)', () => {
    const reg = new PageRegistry();
    const { ctx } = makeContext({ pagesThrow: true });
    expect(() => registerContext(reg, ctx)).not.toThrow();
  });
});

describe('registerContext — page event of a page already gone', () => {
  it('swallows a page event whose page cannot be registered', () => {
    const reg = new PageRegistry();
    const { ctx, emitPage } = makeContext();
    registerContext(reg, ctx);
    const gone = {
      context: () => {
        throw new Error('target page has been closed');
      },
    } as unknown as Page;
    expect(() => emitPage(gone)).not.toThrow();
    expect(reg.list()).toHaveLength(0);
  });
});
