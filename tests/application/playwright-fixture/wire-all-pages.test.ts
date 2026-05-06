/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// `browser` is worker-scoped: a `newContext`/`newPage` patch that
// fails to restore leaks into the next test in the same worker. The
// tests here exercise that contract from every angle.

import { describe, it, expect } from 'vitest';
import type { APIRequest, APIRequestContext, Browser, BrowserContext, Page } from 'playwright';
import {
  wireAllPages,
  wireInitialPage,
  type WireableSession,
} from '../../../src/application/playwright-fixture/wire-all-pages';

function makeSession(): WireableSession & {
  attached: BrowserContext[];
  attachedApi: APIRequestContext[];
} {
  const attached: BrowserContext[] = [];
  const attachedApi: APIRequestContext[] = [];
  return {
    attached,
    attachedApi,
    attachToContext(ctx) {
      attached.push(ctx);
    },
    attachToApiRequestContext(api) {
      attachedApi.push(api);
    },
  };
}

function makeBrowser(initialContexts: BrowserContext[] = []) {
  let newContextCalls = 0;
  let newPageCalls = 0;
  const browser = {
    contexts: () => initialContexts,
    newContext: async (..._args: unknown[]): Promise<BrowserContext> => {
      newContextCalls++;
      void _args;
      return {} as unknown as BrowserContext;
    },
    newPage: async (..._args: unknown[]): Promise<Page> => {
      newPageCalls++;
      void _args;
      const ctx = {} as unknown as BrowserContext;
      return { context: () => ctx } as unknown as Page;
    },
  };
  return {
    browser: browser as unknown as Browser,
    counts: () => ({ newContextCalls, newPageCalls }),
    raw: browser,
  };
}

function makeApiRequest() {
  let calls = 0;
  const api = {
    newContext: async (..._args: unknown[]): Promise<APIRequestContext> => {
      calls++;
      void _args;
      return {} as unknown as APIRequestContext;
    },
  };
  return {
    apiRequest: api as unknown as APIRequest,
    raw: api,
    calls: () => calls,
  };
}

describe('wireInitialPage', () => {
  it("attaches every session to the page's BrowserContext", () => {
    const ctx = {} as unknown as BrowserContext;
    const page = { context: () => ctx } as unknown as Page;
    const s1 = makeSession();
    const s2 = makeSession();
    wireInitialPage([s1, s2], page);
    expect(s1.attached).toEqual([ctx]);
    expect(s2.attached).toEqual([ctx]);
  });
});

describe('wireAllPages', () => {
  it('wires every existing browser.contexts() up-front', () => {
    const ctxA = { id: 'a' } as unknown as BrowserContext;
    const ctxB = { id: 'b' } as unknown as BrowserContext;
    const { browser } = makeBrowser([ctxA, ctxB]);
    const session = makeSession();
    wireAllPages([session], { browser });
    expect(session.attached).toEqual([ctxA, ctxB]);
  });

  it('wires contexts created via the patched browser.newContext', async () => {
    const { browser, raw, counts } = makeBrowser();
    const session = makeSession();
    wireAllPages([session], { browser });

    const ctx = await browser.newContext();
    expect(session.attached).toContain(ctx);
    expect(counts().newContextCalls).toBe(1);
    void raw;
  });

  it('wires the BrowserContext of pages created via browser.newPage', async () => {
    const { browser, counts } = makeBrowser();
    const session = makeSession();
    wireAllPages([session], { browser });

    const page = await browser.newPage();
    expect(session.attached).toEqual([page.context()]);
    expect(counts().newPageCalls).toBe(1);
  });

  it('forwards arguments to the original newContext', async () => {
    const { browser, raw } = makeBrowser();
    let receivedArgs: unknown[] = [];
    raw.newContext = async (...args: unknown[]) => {
      receivedArgs = args;
      return {} as unknown as BrowserContext;
    };
    wireAllPages([makeSession()], { browser });
    await browser.newContext({ viewport: { width: 1, height: 2 } });
    expect(receivedArgs).toEqual([{ viewport: { width: 1, height: 2 } }]);
  });

  it('restore() puts the original newContext / newPage back', async () => {
    const { browser, raw } = makeBrowser();
    const originalNewContext = raw.newContext;
    const originalNewPage = raw.newPage;

    const restore = wireAllPages([makeSession()], { browser });
    expect(browser.newContext).not.toBe(originalNewContext);
    expect(browser.newPage).not.toBe(originalNewPage);

    restore();
    expect(browser.newContext).toBe(originalNewContext);
    expect(browser.newPage).toBe(originalNewPage);
  });

  it('after restore(), a new context is NOT routed through the sessions', async () => {
    const { browser } = makeBrowser();
    const session = makeSession();
    const restore = wireAllPages([session], { browser });
    await browser.newContext();
    expect(session.attached).toHaveLength(1);
    restore();
    await browser.newContext();
    expect(session.attached).toHaveLength(1); // unchanged
  });

  it('patches APIRequest.newContext when sessions support attachToApiRequestContext', async () => {
    const { browser } = makeBrowser();
    const { apiRequest } = makeApiRequest();
    const session = makeSession();
    wireAllPages([session], { browser, apiRequest });

    const api = await apiRequest.newContext();
    expect(session.attachedApi).toEqual([api]);
  });

  it('does NOT patch APIRequest when no session implements attachToApiRequestContext', async () => {
    const { browser } = makeBrowser();
    const { apiRequest, raw } = makeApiRequest();
    const original = raw.newContext;
    const sessionWithoutApi: WireableSession = {
      attachToContext: () => {},
    };
    wireAllPages([sessionWithoutApi], { browser, apiRequest });
    // Patch must not have been applied — the function reference is untouched.
    expect(apiRequest.newContext).toBe(original);
  });

  it('restore() also reverts the APIRequest patch', async () => {
    const { browser } = makeBrowser();
    const { apiRequest, raw } = makeApiRequest();
    const original = raw.newContext;
    const restore = wireAllPages([makeSession()], { browser, apiRequest });
    expect(apiRequest.newContext).not.toBe(original);
    restore();
    expect(apiRequest.newContext).toBe(original);
  });
});
