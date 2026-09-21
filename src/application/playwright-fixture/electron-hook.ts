/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Builds the per-test Electron hook the fixture installs in the active
// slot: what to add to a launch's options (a `recordVideo` that mirrors
// the video mode Electron windows follow) and what to do with the
// launched app (register its context and windows with this test's
// registry and capture sessions).
//
// Extracted from the fixture so the policy is unit-testable without
// driving a Playwright run.

import type { TestInfo } from '@playwright/test';
import {
  registerElectronApp,
  normalizeVideoMode,
  shouldRecord,
  videoSizeFrom,
  type ElectronHook,
  type ElectronLaunchOptions,
  type ElectronVideoMode,
  type ElectronWireableSession,
} from '../../infrastructure/playwright-electron-adapter';
import type { PageRegistry } from '../../infrastructure/playwright-page-registry-adapter';
import type { HealTracerElectronConfig } from '../heal-config';

/**
 * Where a launch's recording goes, relative to the test's output dir —
 * inside it, because the reporter drops any attachment that resolves
 * outside `testInfo.outputDir`.
 */
export const ELECTRON_VIDEO_DIR = 'electron-video';

/**
 * The video mode Electron windows follow in this test: the
 * `configureTracer({ electron: { video } })` override when set, else
 * the project's own `use.video`.
 */
export function electronVideoMode(
  config: HealTracerElectronConfig | undefined,
  useVideo: unknown,
): ElectronVideoMode {
  return config?.video ?? normalizeVideoMode(useVideo);
}

export interface ElectronHookDeps {
  testInfo: Pick<TestInfo, 'outputPath' | 'retry'>;
  /** The mode from `electronVideoMode`. */
  mode: ElectronVideoMode;
  /** The project's `use.video`, read for its optional `size`. */
  useVideo: unknown;
  registry: PageRegistry;
  sessions: ElectronWireableSession[];
}

export function buildElectronHook(deps: ElectronHookDeps): ElectronHook {
  const { testInfo, mode, useVideo, registry, sessions } = deps;
  return {
    beforeLaunch(options: ElectronLaunchOptions): ElectronLaunchOptions {
      // The caller's own recordVideo (or an explicit `undefined`
      // key) is their choice; we only fill an absent one.
      if ('recordVideo' in options) return options;
      if (!shouldRecord(mode, testInfo.retry)) return options;
      const size = videoSizeFrom(useVideo);
      return {
        ...options,
        recordVideo: { dir: testInfo.outputPath(ELECTRON_VIDEO_DIR), ...(size ? { size } : {}) },
      };
    },
    onLaunched(app, info): void {
      registerElectronApp({ app, registry, sessions, owned: info.owned });
    },
  };
}
