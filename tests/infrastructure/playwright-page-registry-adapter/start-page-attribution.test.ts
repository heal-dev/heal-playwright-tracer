/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import {
  PageRegistry,
  startPageAttribution,
  getActivePageStamper,
  setActivePageStamper,
} from '../../../src/infrastructure/playwright-page-registry-adapter';

afterEach(() => setActivePageStamper(null));

// A page double with a controllable url() and a real-ish prototype so
// the navigation patch has something to grab.
function makePage(url: string | (() => never), ctx: BrowserContext): Page {
  const proto = { goto: async () => undefined };
  const page = Object.create(proto) as Record<string, unknown>;
  page.context = () => ctx;
  page.url = typeof url === 'function' ? url : () => url;
  return page as unknown as Page;
}

describe('startPageAttribution', () => {
  it('registers the primary page as ctx0/p0 and installs a stamper', () => {
    const reg = new PageRegistry();
    const ctx = {} as unknown as BrowserContext;
    const primary = makePage('https://app.test/', ctx);

    startPageAttribution(primary, reg, () => {});
    expect(reg.idForPage(primary)).toBe('ctx0/p0');
    expect(getActivePageStamper()).not.toBeNull();
  });

  it('stamper resolves a page to its id + live URL and forwards to onPageResolved', () => {
    const reg = new PageRegistry();
    const ctxA = {} as unknown as BrowserContext;
    const ctxB = {} as unknown as BrowserContext;
    const primary = makePage('https://app.test/home', ctxA);
    const resolved: Array<{ id: string; url: string | undefined }> = [];

    startPageAttribution(primary, reg, (id, url) => resolved.push({ id, url }));
    const stamp = getActivePageStamper()!;

    stamp(primary);
    stamp(makePage('https://other.test/x', ctxB));

    expect(resolved).toEqual([
      { id: 'ctx0/p0', url: 'https://app.test/home' },
      { id: 'ctx1/p0', url: 'https://other.test/x' },
    ]);
  });

  it('reports undefined URL (not a throw) when page.url() fails', () => {
    const reg = new PageRegistry();
    const ctx = {} as unknown as BrowserContext;
    const primary = makePage('https://app.test/', ctx);
    const throwingPage = makePage(() => {
      throw new Error('page closed');
    }, ctx);
    const resolved: Array<{ id: string; url: string | undefined }> = [];

    startPageAttribution(primary, reg, (id, url) => resolved.push({ id, url }));
    const stamp = getActivePageStamper()!;
    expect(() => stamp(throwingPage)).not.toThrow();
    expect(resolved[0]).toEqual({ id: 'ctx0/p1', url: undefined });
  });

  it('the disposer clears the active stamper', () => {
    const reg = new PageRegistry();
    const primary = makePage('https://app.test/', {} as unknown as BrowserContext);
    const stop = startPageAttribution(primary, reg, () => {});
    expect(getActivePageStamper()).not.toBeNull();
    stop();
    expect(getActivePageStamper()).toBeNull();
  });
});
