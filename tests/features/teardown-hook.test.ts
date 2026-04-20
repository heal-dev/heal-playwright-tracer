import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTeardownHook } from '../../src/features/teardown-hook';

type HookGlobal = {
  __heal_teardown_hook?: (() => Promise<void>) | unknown;
};

function hookSlot(): HookGlobal {
  return globalThis as HookGlobal;
}

beforeEach(() => {
  hookSlot().__heal_teardown_hook = undefined;
});

afterEach(() => {
  hookSlot().__heal_teardown_hook = undefined;
});

describe('runTeardownHook', () => {
  it('is a no-op when no hook is registered', async () => {
    await expect(runTeardownHook()).resolves.toBeUndefined();
    expect(hookSlot().__heal_teardown_hook).toBeUndefined();
  });

  it('invokes the registered hook exactly once and clears the slot', async () => {
    const hook = vi.fn().mockResolvedValue(undefined);
    hookSlot().__heal_teardown_hook = hook;

    await runTeardownHook();

    expect(hook).toHaveBeenCalledTimes(1);
    expect(hookSlot().__heal_teardown_hook).toBeUndefined();
  });

  it('clears the slot BEFORE invoking the hook (re-entry protection)', async () => {
    let slotAtEntry: unknown = 'unchanged';
    const hook = vi.fn().mockImplementation(async () => {
      slotAtEntry = hookSlot().__heal_teardown_hook;
    });
    hookSlot().__heal_teardown_hook = hook;

    await runTeardownHook();

    expect(slotAtEntry).toBeUndefined();
  });

  it('swallows errors thrown by the hook and logs to stderr', async () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hook = vi.fn().mockRejectedValue(new Error('boom'));
    hookSlot().__heal_teardown_hook = hook;

    await expect(runTeardownHook()).resolves.toBeUndefined();

    expect(hook).toHaveBeenCalledTimes(1);
    expect(consoleErr).toHaveBeenCalledTimes(1);
    const call = consoleErr.mock.calls[0] as unknown[];
    expect(String(call[0])).toContain('[heal-playwright-tracer] teardown hook failed');
    consoleErr.mockRestore();
  });

  it('skips invocation when the slot holds a non-function value', async () => {
    // Someone mis-set the global — e.g. a string. We shouldn't attempt
    // to call it, and we should still clear the slot.
    (hookSlot() as unknown as { __heal_teardown_hook: unknown }).__heal_teardown_hook =
      'not a function' as unknown;

    await expect(runTeardownHook()).resolves.toBeUndefined();

    expect(hookSlot().__heal_teardown_hook).toBeUndefined();
  });

  it('is safe to call twice in a row (second call is a no-op)', async () => {
    const hook = vi.fn().mockResolvedValue(undefined);
    hookSlot().__heal_teardown_hook = hook;

    await runTeardownHook();
    await runTeardownHook();

    expect(hook).toHaveBeenCalledTimes(1);
  });
});
