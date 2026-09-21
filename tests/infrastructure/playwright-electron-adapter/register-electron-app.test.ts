/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { BrowserContext, ElectronApplication, Page } from 'playwright';
import { PageRegistry } from '../../../src/infrastructure/playwright-page-registry-adapter';
import {
  registerActiveElectronApp,
  registerElectronApp,
  setActiveElectronHook,
} from '../../../src/infrastructure/playwright-electron-adapter';

// A BrowserContext double with pages() and a hand-rolled `page` event
// (what Playwright derives the app's `window` event from).
function makeContext() {
  const pages: Page[] = [];
  const listeners: Array<(p: Page) => void> = [];
  const ctx = {
    pages: () => pages.slice(),
    on: (event: string, cb: (p: Page) => void) => {
      if (event === 'page') listeners.push(cb);
      return ctx;
    },
  } as unknown as BrowserContext;
  const addWindow = (): Page => {
    const p = { context: () => ctx } as unknown as Page;
    pages.push(p);
    return p;
  };
  return {
    ctx,
    addWindow,
    emitWindow: (p: Page) => listeners.forEach((l) => l(p)),
    listenerCount: () => listeners.length,
  };
}

// An ElectronApplication double: context() only.
function makeApp(ctx: BrowserContext, opts: { contextThrows?: boolean } = {}): ElectronApplication {
  return {
    context: () => {
      if (opts.contextThrows) throw new Error('app closed');
      return ctx;
    },
  } as unknown as ElectronApplication;
}

function makeSession() {
  return { attachToContext: vi.fn() };
}

// The fixture registers the built-in page first; an Electron context is
// then the second context the registry sees.
function registryWithPrimary(): PageRegistry {
  const reg = new PageRegistry();
  const primaryCtx = {} as unknown as BrowserContext;
  reg.ensurePageId({ context: () => primaryCtx } as unknown as Page);
  return reg;
}

afterEach(() => setActiveElectronHook(null));

describe('registerElectronApp', () => {
  it('registers the existing windows as electron pages of a new context', () => {
    const registry = registryWithPrimary();
    const { ctx, addWindow } = makeContext();
    const win = addWindow();

    registerElectronApp({ app: makeApp(ctx), registry, sessions: [], owned: true });

    expect(registry.idForPage(win)).toBe('ctx1/p0');
    expect(registry.entryForPage(win)).toMatchObject({ kind: 'electron' });
    expect(registry.entryForPage(win)?.owned).toBeUndefined();
  });

  it('registers a window opened later, with the electron mark', () => {
    const registry = registryWithPrimary();
    const { ctx, addWindow, emitWindow } = makeContext();
    registerElectronApp({ app: makeApp(ctx), registry, sessions: [], owned: true });

    const later = addWindow();
    emitWindow(later);

    expect(registry.idForPage(later)).toBe('ctx1/p0');
    expect(registry.entryForPage(later)?.kind).toBe('electron');
  });

  it('marks an app registered by hand as not owned', () => {
    const registry = registryWithPrimary();
    const { ctx, addWindow } = makeContext();
    const win = addWindow();

    registerElectronApp({ app: makeApp(ctx), registry, sessions: [], owned: false });

    expect(registry.entryForPage(win)).toMatchObject({ kind: 'electron', owned: false });
  });

  it('attaches every capture session to the context, once', () => {
    const registry = registryWithPrimary();
    const { ctx, listenerCount } = makeContext();
    const app = makeApp(ctx);
    const a = makeSession();
    const b = makeSession();

    registerElectronApp({ app, registry, sessions: [a, b], owned: true });
    registerElectronApp({ app, registry, sessions: [a, b], owned: true }); // no-op

    expect(a.attachToContext).toHaveBeenCalledTimes(1);
    expect(a.attachToContext).toHaveBeenCalledWith(ctx);
    expect(b.attachToContext).toHaveBeenCalledTimes(1);
    expect(listenerCount()).toBe(1);
  });

  it('wires the same app again for a different registry (a new test)', () => {
    const { ctx } = makeContext();
    const app = makeApp(ctx);
    const first = makeSession();
    const second = makeSession();

    registerElectronApp({ app, registry: new PageRegistry(), sessions: [first], owned: false });
    registerElectronApp({ app, registry: new PageRegistry(), sessions: [second], owned: false });

    expect(first.attachToContext).toHaveBeenCalledTimes(1);
    expect(second.attachToContext).toHaveBeenCalledTimes(1);
  });

  it('swallows a throwing session without skipping the others', () => {
    const registry = registryWithPrimary();
    const { ctx } = makeContext();
    const bad = {
      attachToContext: () => {
        throw new Error('session boom');
      },
    };
    const good = makeSession();

    expect(() =>
      registerElectronApp({ app: makeApp(ctx), registry, sessions: [bad, good], owned: true }),
    ).not.toThrow();
    expect(good.attachToContext).toHaveBeenCalledTimes(1);
  });

  it('swallows an app whose context() throws (already closed)', () => {
    const registry = registryWithPrimary();
    const { ctx } = makeContext();
    const session = makeSession();

    expect(() =>
      registerElectronApp({
        app: makeApp(ctx, { contextThrows: true }),
        registry,
        sessions: [session],
        owned: true,
      }),
    ).not.toThrow();
    expect(session.attachToContext).not.toHaveBeenCalled();
  });
});

describe('registerActiveElectronApp', () => {
  it('hands the app to the active hook as not owned', () => {
    const onLaunched = vi.fn();
    setActiveElectronHook({ beforeLaunch: (o) => o, onLaunched });
    const app = makeApp(makeContext().ctx);

    registerActiveElectronApp(app);

    expect(onLaunched).toHaveBeenCalledWith(app, { owned: false });
  });

  it('is a no-op outside a traced test', () => {
    expect(() => registerActiveElectronApp(makeApp(makeContext().ctx))).not.toThrow();
  });
});

describe('registerElectronApp — repeated registration', () => {
  it('keeps the first owned flag when the same app is registered again', () => {
    const registry = registryWithPrimary();
    const { ctx, addWindow } = makeContext();
    const win = addWindow();
    const app = makeApp(ctx);

    registerElectronApp({ app, registry, sessions: [], owned: true });
    registerElectronApp({ app, registry, sessions: [], owned: false }); // no-op

    expect(registry.entryForPage(win)?.owned).toBeUndefined();
  });
});

describe('registerActiveElectronApp — a throwing hook', () => {
  it('never lets a hook error reach the caller', () => {
    setActiveElectronHook({
      beforeLaunch: (o) => o,
      onLaunched: () => {
        throw new Error('register boom');
      },
    });
    expect(() => registerActiveElectronApp(makeApp(makeContext().ctx))).not.toThrow();
  });
});
