/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Electron, ElectronApplication } from 'playwright';
import {
  ensureElectronLaunchPatched,
  setActiveElectronHook,
  type ElectronHook,
  type ElectronLaunchOptions,
} from '../../../src/infrastructure/playwright-electron-adapter';

type LaunchImpl = (options?: ElectronLaunchOptions) => Promise<unknown>;
type Launchable = { launch: LaunchImpl };

// Each test builds a FRESH prototype object so the process-global
// idempotency Symbol on the prototype never leaks across cases.
function makeElectronOnFreshProto(launch?: LaunchImpl): {
  electron: Electron;
  proto: Record<string, unknown>;
} {
  const proto = (launch ? { launch } : {}) as Record<string, unknown>;
  const electron = Object.create(proto) as Electron;
  return { electron, proto };
}

const APP = { context: () => ({}) } as unknown as ElectronApplication;

function hookOf(over: Partial<ElectronHook> = {}): ElectronHook {
  return { beforeLaunch: (o) => o, onLaunched: () => {}, ...over };
}

afterEach(() => setActiveElectronHook(null));

describe('ensureElectronLaunchPatched', () => {
  it('launches with the options the hook returns and hands the app to it as owned', async () => {
    const received: unknown[] = [];
    const { electron } = makeElectronOnFreshProto(async (o) => {
      received.push(o);
      return APP;
    });
    ensureElectronLaunchPatched(electron);
    const onLaunched = vi.fn();
    setActiveElectronHook(
      hookOf({
        beforeLaunch: (o) => ({ ...o, recordVideo: { dir: '/out/electron-video' } }),
        onLaunched,
      }),
    );

    const app = await (electron as unknown as Launchable).launch({ args: ['main.js'] });

    expect(app).toBe(APP);
    expect(received).toEqual([{ args: ['main.js'], recordVideo: { dir: '/out/electron-video' } }]);
    expect(onLaunched).toHaveBeenCalledWith(APP, { owned: true });
  });

  it('gives the hook an empty options object when the caller passed none', async () => {
    const { electron } = makeElectronOnFreshProto(async () => APP);
    ensureElectronLaunchPatched(electron);
    const beforeLaunch = vi.fn((o: ElectronLaunchOptions) => o);
    setActiveElectronHook(hookOf({ beforeLaunch }));

    await (electron as unknown as Launchable).launch();
    expect(beforeLaunch).toHaveBeenCalledWith({});
  });

  it('passes the caller options through untouched when no hook is active', async () => {
    const received: unknown[] = [];
    const { electron } = makeElectronOnFreshProto(async (o) => {
      received.push(o);
      return APP;
    });
    ensureElectronLaunchPatched(electron);
    const options = { args: ['main.js'] };

    await (electron as unknown as Launchable).launch(options);
    await (electron as unknown as Launchable).launch();
    expect(received[0]).toBe(options); // same reference, not a copy
    expect(received[1]).toBeUndefined();
  });

  it('falls back to the caller options when beforeLaunch throws', async () => {
    const received: unknown[] = [];
    const { electron } = makeElectronOnFreshProto(async (o) => {
      received.push(o);
      return APP;
    });
    ensureElectronLaunchPatched(electron);
    const onLaunched = vi.fn();
    setActiveElectronHook(
      hookOf({
        beforeLaunch: () => {
          throw new Error('policy boom');
        },
        onLaunched,
      }),
    );
    const options = { args: ['main.js'] };

    await expect((electron as unknown as Launchable).launch(options)).resolves.toBe(APP);
    expect(received[0]).toBe(options);
    expect(onLaunched).toHaveBeenCalledTimes(1);
  });

  it('does not let a throwing onLaunched mask the launched app', async () => {
    const { electron } = makeElectronOnFreshProto(async () => APP);
    ensureElectronLaunchPatched(electron);
    setActiveElectronHook(
      hookOf({
        onLaunched: () => {
          throw new Error('register boom');
        },
      }),
    );

    await expect((electron as unknown as Launchable).launch()).resolves.toBe(APP);
  });

  it('propagates a launch failure and never calls onLaunched', async () => {
    const { electron } = makeElectronOnFreshProto(async () => {
      throw new Error('electron not found');
    });
    ensureElectronLaunchPatched(electron);
    const onLaunched = vi.fn();
    setActiveElectronHook(hookOf({ onLaunched }));

    await expect((electron as unknown as Launchable).launch()).rejects.toThrow(
      'electron not found',
    );
    expect(onLaunched).not.toHaveBeenCalled();
  });

  it('is idempotent — patching the same prototype twice keeps one wrapper', async () => {
    let calls = 0;
    const { electron, proto } = makeElectronOnFreshProto(async () => {
      calls++;
      return APP;
    });
    ensureElectronLaunchPatched(electron);
    const firstWrapper = proto.launch;
    ensureElectronLaunchPatched(electron);
    expect(proto.launch).toBe(firstWrapper);

    setActiveElectronHook(hookOf());
    await (electron as unknown as Launchable).launch();
    expect(calls).toBe(1);
  });

  it('keeps the hook it read at call time even if the slot is cleared mid-launch', async () => {
    let release: () => void = () => {};
    const { electron } = makeElectronOnFreshProto(
      () =>
        new Promise((resolve) => {
          release = () => resolve(APP);
        }),
    );
    ensureElectronLaunchPatched(electron);
    const onLaunched = vi.fn();
    setActiveElectronHook(hookOf({ onLaunched }));

    const pending = (electron as unknown as Launchable).launch();
    setActiveElectronHook(null); // teardown races the launch
    release();
    await pending;

    expect(onLaunched).toHaveBeenCalledTimes(1);
  });

  it('leaves a prototype without launch alone', () => {
    const { electron, proto } = makeElectronOnFreshProto();
    expect(() => ensureElectronLaunchPatched(electron)).not.toThrow();
    expect(proto.launch).toBeUndefined();
  });
});

describe('ensureElectronLaunchPatched — this binding', () => {
  it('invokes the original with the electron instance as `this`', async () => {
    const seen: unknown[] = [];
    const { electron } = makeElectronOnFreshProto(async function (this: unknown) {
      seen.push(this);
      return APP;
    });
    ensureElectronLaunchPatched(electron);
    setActiveElectronHook(hookOf());

    await (electron as unknown as Launchable).launch();
    expect(seen).toEqual([electron]);
  });
});
