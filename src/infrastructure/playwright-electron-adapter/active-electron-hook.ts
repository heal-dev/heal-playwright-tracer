/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Active Electron hook — the process-global slot the patched
// `_electron.launch` reads to hand a launch to the running test.
//
// Mirrors `active-page-stamper.ts`: the launch patch is process-global
// and lexically fixed, so it cannot close over a per-test registry
// directly. The fixture installs a hook at test start (a closure over
// the per-test `PageRegistry`, the capture sessions and `testInfo`) and
// clears it at teardown. The patched launch reads `getActiveElectronHook`
// on every call and leaves the launch untouched when it is null (a
// launch outside a test, or Electron support turned off).

import type { ElectronApplication } from 'playwright';

/** The options object `_electron.launch()` was called with (or `{}`). */
export type ElectronLaunchOptions = Record<string, unknown>;

export interface ElectronHook {
  /**
   * Called before the original `launch` with the caller's options.
   * Returns the options to launch with — the fixture uses it to add
   * `recordVideo` when the project records video and the caller did
   * not set one. Must not mutate the caller's object.
   */
  beforeLaunch(options: ElectronLaunchOptions): ElectronLaunchOptions;
  /**
   * Called once the original `launch` resolved, with the app. `owned`
   * is true for an app the patched launch saw (the test owns it: closed
   * at teardown so its video flushes) and false for an app the host
   * registered by hand (`registerElectronApp`).
   */
  onLaunched(app: ElectronApplication, info: { owned: boolean }): void;
}

let activeHook: ElectronHook | null = null;

export function setActiveElectronHook(hook: ElectronHook | null): void {
  activeHook = hook;
}

export function getActiveElectronHook(): ElectronHook | null {
  return activeHook;
}
