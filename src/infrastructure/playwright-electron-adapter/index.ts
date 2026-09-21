/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Feature: electron — an app launched with `_electron.launch()` inside
// a test is traced like the built-in page: its windows get page ids at
// creation, the network and console streams cover its context, and it
// is recorded on video and attached at teardown.
//
//   - active-electron-hook.ts   — process-global slot the launch patch reads
//   - electron-launch-patch.ts  — Electron.prototype.launch interception
//   - register-electron-app.ts  — an app's context + windows into the registry
//   - electron-video-policy.ts  — record/keep rules mirroring `use.video`

export {
  setActiveElectronHook,
  getActiveElectronHook,
  type ElectronHook,
  type ElectronLaunchOptions,
} from './active-electron-hook';
export { ensureElectronLaunchPatched } from './electron-launch-patch';
export {
  registerElectronApp,
  registerActiveElectronApp,
  type ElectronWireableSession,
  type RegisterElectronAppOptions,
} from './register-electron-app';
export {
  normalizeVideoMode,
  videoSizeFrom,
  shouldRecord,
  shouldKeep,
  type ElectronVideoMode,
  type VideoSize,
  type KeepContext,
} from './electron-video-policy';
