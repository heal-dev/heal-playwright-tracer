/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect, vi } from 'vitest';
import type { BrowserContext, ElectronApplication, Page } from 'playwright';
import {
  ELECTRON_VIDEO_DIR,
  buildElectronHook,
  electronVideoMode,
} from '../../../src/application/playwright-fixture/electron-hook';
import { PageRegistry } from '../../../src/infrastructure/playwright-page-registry-adapter';

// The slice of testInfo the hook reads: outputPath and retry.
function makeTestInfo(retry = 0) {
  return { outputPath: (...parts: string[]) => ['/out', ...parts].join('/'), retry };
}

function makeApp(): { app: ElectronApplication; ctx: BrowserContext; win: Page } {
  const pages: Page[] = [];
  const ctx = {
    pages: () => pages.slice(),
    on: () => ctx,
  } as unknown as BrowserContext;
  const win = { context: () => ctx } as unknown as Page;
  pages.push(win);
  const app = { context: () => ctx } as unknown as ElectronApplication;
  return { app, ctx, win };
}

function hookWith(
  over: { mode?: 'on' | 'off' | 'on-first-retry'; retry?: number; useVideo?: unknown } = {},
) {
  const registry = new PageRegistry();
  const sessions = [{ attachToContext: vi.fn() }];
  const hook = buildElectronHook({
    testInfo: makeTestInfo(over.retry),
    mode: over.mode ?? 'on',
    useVideo: over.useVideo,
    registry,
    sessions,
  });
  return { hook, registry, sessions };
}

describe('electronVideoMode', () => {
  it('follows the project video mode by default', () => {
    expect(electronVideoMode(undefined, 'retain-on-failure')).toBe('retain-on-failure');
    expect(electronVideoMode({ enabled: true }, undefined)).toBe('off');
  });

  it('lets the configureTracer override win over the project mode', () => {
    expect(electronVideoMode({ video: 'on' }, 'off')).toBe('on');
    expect(electronVideoMode({ video: 'off' }, 'on')).toBe('off');
  });
});

describe('buildElectronHook.beforeLaunch', () => {
  it('adds a recordVideo whose dir is under the test output dir', () => {
    const { hook } = hookWith({ mode: 'on' });
    const options = hook.beforeLaunch({ args: ['main.js'] });
    expect(options).toEqual({
      args: ['main.js'],
      recordVideo: { dir: `/out/${ELECTRON_VIDEO_DIR}` },
    });
  });

  it('never mutates the caller options object', () => {
    const { hook } = hookWith({ mode: 'on' });
    const caller = { args: ['main.js'] };
    hook.beforeLaunch(caller);
    expect(caller).toEqual({ args: ['main.js'] });
  });

  it('lets the caller recordVideo win', () => {
    const { hook } = hookWith({ mode: 'on' });
    const caller = { recordVideo: { dir: '/mine' } };
    expect(hook.beforeLaunch(caller)).toBe(caller);
    const explicitOff = { recordVideo: undefined };
    expect(hook.beforeLaunch(explicitOff)).toBe(explicitOff);
  });

  it('injects nothing when the mode is off', () => {
    const { hook } = hookWith({ mode: 'off' });
    const caller = { args: ['main.js'] };
    expect(hook.beforeLaunch(caller)).toBe(caller);
  });

  it('records on the first retry only under on-first-retry', () => {
    expect(hookWith({ mode: 'on-first-retry', retry: 0 }).hook.beforeLaunch({})).toEqual({});
    expect(hookWith({ mode: 'on-first-retry', retry: 1 }).hook.beforeLaunch({})).toHaveProperty(
      'recordVideo',
    );
    expect(hookWith({ mode: 'on-first-retry', retry: 2 }).hook.beforeLaunch({})).toEqual({});
  });

  it('carries the size of an object-form project video option', () => {
    const { hook } = hookWith({
      mode: 'on',
      useVideo: { mode: 'on', size: { width: 640, height: 480 } },
    });
    expect(hook.beforeLaunch({})).toEqual({
      recordVideo: { dir: `/out/${ELECTRON_VIDEO_DIR}`, size: { width: 640, height: 480 } },
    });
  });
});

describe('buildElectronHook.onLaunched', () => {
  it('registers the app windows as electron pages and wires the sessions', () => {
    const { hook, registry, sessions } = hookWith();
    const { app, ctx, win } = makeApp();

    hook.onLaunched(app, { owned: true });

    expect(registry.entryForPage(win)).toMatchObject({ pageId: 'ctx0/p0', kind: 'electron' });
    expect(registry.entryForPage(win)?.owned).toBeUndefined();
    expect(sessions[0].attachToContext).toHaveBeenCalledWith(ctx);
  });

  it('keeps the owned flag of an app registered by hand', () => {
    const { hook, registry } = hookWith();
    const { app, win } = makeApp();

    hook.onLaunched(app, { owned: false });

    expect(registry.entryForPage(win)?.owned).toBe(false);
  });
});

describe('buildElectronHook.beforeLaunch — retain-on-failure', () => {
  it('records from the first attempt (the outcome is only known at teardown)', () => {
    const registry = new PageRegistry();
    const hook = buildElectronHook({
      testInfo: makeTestInfo(0),
      mode: 'retain-on-failure',
      useVideo: 'retain-on-failure',
      registry,
      sessions: [],
    });
    expect(hook.beforeLaunch({})).toHaveProperty('recordVideo');
  });
});
