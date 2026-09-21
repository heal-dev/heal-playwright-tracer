/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  getActiveElectronHook,
  setActiveElectronHook,
  type ElectronHook,
} from '../../../src/infrastructure/playwright-electron-adapter';

afterEach(() => setActiveElectronHook(null));

describe('active electron hook slot', () => {
  it('is empty until a hook is installed', () => {
    expect(getActiveElectronHook()).toBeNull();
  });

  it('returns the installed hook, then null once cleared', () => {
    const hook: ElectronHook = {
      beforeLaunch: (o) => o,
      onLaunched: () => {},
    };
    setActiveElectronHook(hook);
    expect(getActiveElectronHook()).toBe(hook);
    setActiveElectronHook(null);
    expect(getActiveElectronHook()).toBeNull();
  });
});
