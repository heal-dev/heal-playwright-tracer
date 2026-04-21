/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  configureTracer,
  getTracerConfig,
  onTestTeardown,
  resetTeardownHooks,
  drainTeardownHooks,
} from '../../../src/application/heal-config';

describe('heal-config registry', () => {
  beforeEach(() => {
    configureTracer({});
    resetTeardownHooks();
  });

  it('configureTracer overwrites previously registered config (no merge)', () => {
    configureTracer({ exporters: [() => ({ write: () => {}, close: async () => {} })] });
    configureTracer({ lifecycles: [() => ({ setup: () => {}, teardown: () => {} })] });

    const cfg = getTracerConfig();
    expect(cfg.exporters).toBeUndefined();
    expect(cfg.lifecycles).toHaveLength(1);
  });

  it('getTracerConfig returns the empty config by default', () => {
    expect(getTracerConfig()).toEqual({});
  });

  describe('teardown hooks', () => {
    it('onTestTeardown + drainTeardownHooks runs hooks in registration order', async () => {
      const calls: number[] = [];
      onTestTeardown(() => void calls.push(1));
      onTestTeardown(async () => void calls.push(2));
      onTestTeardown(() => void calls.push(3));

      await drainTeardownHooks();
      expect(calls).toEqual([1, 2, 3]);
    });

    it('drain empties the registry so a second drain is a no-op', async () => {
      const fn = vi.fn();
      onTestTeardown(fn);
      await drainTeardownHooks();
      await drainTeardownHooks();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('resetTeardownHooks clears pending hooks without running them', async () => {
      const fn = vi.fn();
      onTestTeardown(fn);
      resetTeardownHooks();
      await drainTeardownHooks();
      expect(fn).not.toHaveBeenCalled();
    });

    it('logs and swallows errors raised by a hook, keeps draining subsequent hooks', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const after = vi.fn();
      onTestTeardown(() => {
        throw new Error('boom');
      });
      onTestTeardown(after);

      await expect(drainTeardownHooks()).resolves.toBeUndefined();
      expect(after).toHaveBeenCalledTimes(1);
      expect(errSpy).toHaveBeenCalledWith(
        '[heal-playwright-tracer] teardown hook failed:',
        expect.any(Error),
      );
      errSpy.mockRestore();
    });
  });

  afterEach(() => {
    resetTeardownHooks();
    configureTracer({});
  });
});
