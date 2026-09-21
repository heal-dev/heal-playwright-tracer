/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Prototype-patches `Electron.launch` — the class behind the `_electron`
// singleton — so an app launched inside a test is handed to the running
// test's hook: the hook can add `recordVideo` before the launch and
// register the app after it. Mirrors `page-navigation-patch.ts`:
// patched once per process, idempotent via a Symbol marker on the
// prototype, and a pass-through whenever no hook is active.
//
// The prototype is taken from a live instance — the `_electron` that
// `@playwright/test` exports, which is the very object `playwright`
// exports (both resolve to one playwright-core). A host that bundles a
// second Playwright copy has a different prototype this patch never
// sees; `registerElectronApp` is the by-hand path for it.

import type { Electron, ElectronApplication } from 'playwright';
import { getActiveElectronHook, type ElectronLaunchOptions } from './active-electron-hook';
import { log } from '../../util/logger';

const PATCHED = Symbol.for('heal-playwright-tracer.electron-launch-patched');

interface PatchableProto {
  [PATCHED]?: boolean;
  launch?: unknown;
}

type LaunchFn = (this: unknown, options?: ElectronLaunchOptions) => Promise<ElectronApplication>;

// Idempotent proto patch. Call once per process with the `_electron`
// instance — we grab its prototype and wrap `launch`.
export function ensureElectronLaunchPatched(sampleElectron: Electron): void {
  const proto = Object.getPrototypeOf(sampleElectron) as PatchableProto | null;
  if (!proto || proto[PATCHED]) return;
  const orig = proto.launch;
  if (typeof orig !== 'function') {
    log.warn('Electron support is off: this Playwright exposes no _electron.launch to patch');
    return;
  }
  proto[PATCHED] = true;
  const original = orig as LaunchFn;

  proto.launch = async function patched(this: unknown, options?: ElectronLaunchOptions) {
    // Read the hook ONCE: a teardown that clears the slot while the app
    // is still starting must not leave the launch half-registered.
    const hook = getActiveElectronHook();
    let launchOptions = options;
    if (hook) {
      try {
        launchOptions = hook.beforeLaunch(options ?? {});
      } catch (err) {
        log.warn('electron hook beforeLaunch failed; launching with the caller options', err);
        launchOptions = options;
      }
    }
    const app = await original.call(this, launchOptions);
    if (hook) {
      try {
        hook.onLaunched(app, { owned: true });
      } catch (err) {
        log.warn('electron hook onLaunched failed; the app is not traced', err);
      }
    }
    return app;
  };
}
