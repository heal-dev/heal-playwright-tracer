/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 *
 */

import { describe, it, expect, vi } from 'vitest';
import { PlaywrightStepTrackingAdapter } from '../../../src/infrastructure/playwright-step-tracking-adapter';

describe('PlaywrightStepTrackingAdapter.patch', () => {
  function makeHooks() {
    return { pushStep: vi.fn(), popStep: vi.fn() };
  }

  it('wraps test.step so push/pop bracket the body; forwards title, args, opts, and this', async () => {
    const calls: Array<{
      title: string;
      hasBody: boolean;
      opts: unknown;
      receiver: unknown;
    }> = [];

    const base: {
      step?: (title: string, body: (...a: unknown[]) => unknown, opts?: unknown) => unknown;
      marker?: string;
    } = {
      marker: 'base',
      async step(title, body, opts) {
        calls.push({ title, hasBody: typeof body === 'function', opts, receiver: this });
        return await body('arg1', 'arg2');
      },
    };

    const hooks = makeHooks();
    new PlaywrightStepTrackingAdapter(hooks).patch(base);

    const bodyArgs: unknown[] = [];
    const result = await base.step!(
      'login',
      async (...args) => {
        bodyArgs.push(...args);
        expect(hooks.pushStep).toHaveBeenCalledWith('login');
        expect(hooks.popStep).not.toHaveBeenCalled();
        return 'done';
      },
      { timeout: 1000 },
    );

    expect(result).toBe('done');
    expect(hooks.pushStep).toHaveBeenCalledTimes(1);
    expect(hooks.popStep).toHaveBeenCalledTimes(1);
    expect(bodyArgs).toEqual(['arg1', 'arg2']);
    expect(calls[0].title).toBe('login');
    expect(calls[0].opts).toEqual({ timeout: 1000 });
    expect((calls[0].receiver as { marker?: string }).marker).toBe('base');
  });

  it('popStep is still called when the body throws', async () => {
    const base = {
      async step(_title: string, body: () => Promise<void>) {
        await body();
      },
    };
    const hooks = makeHooks();
    new PlaywrightStepTrackingAdapter(hooks).patch(base);

    await expect(
      base.step('click', async () => {
        throw new Error('body-failed');
      }),
    ).rejects.toThrow('body-failed');
    expect(hooks.pushStep).toHaveBeenCalledWith('click');
    expect(hooks.popStep).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — a second patch leaves the first wrapper in place', async () => {
    const base = {
      async step(_title: string, body: () => Promise<void>) {
        await body();
      },
    };
    const hooks = makeHooks();
    const adapter = new PlaywrightStepTrackingAdapter(hooks);
    adapter.patch(base);
    const patched = base.step;
    adapter.patch(base);
    expect(base.step).toBe(patched);

    await base.step('a', async () => {});
    expect(hooks.pushStep).toHaveBeenCalledTimes(1);
    expect(hooks.popStep).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the target has no step function', () => {
    const base: Record<string, unknown> = {};
    const hooks = makeHooks();
    new PlaywrightStepTrackingAdapter(hooks).patch(base);
    expect(base.step).toBeUndefined();
  });
});
