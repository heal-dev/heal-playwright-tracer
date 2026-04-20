// Feature: if heal-cli (or any future tracer consumer) installed a
// teardown function on `globalThis.__heal_teardown_hook`, invoke it
// during the fixture's `finally` block and clear the slot.
//
// Keeps heal-playwright-tracer free of any import from heal-cli: the
// only contract is the global name. When heal-cli isn't installed or
// wasn't wired into this test, the global is unset and `run()` is a
// no-op.

type TeardownHook = () => Promise<void>;

interface HealTeardownGlobal {
  __heal_teardown_hook?: TeardownHook;
}

/**
 * Invokes the registered teardown hook exactly once. Any error raised
 * by the hook is logged to stderr and swallowed — tracer teardown must
 * not mask a real test failure.
 *
 * The slot is cleared before invocation, which doubles as re-entry
 * protection if a buggy hook somehow triggers fixture teardown again.
 */
export async function runTeardownHook(): Promise<void> {
  const g = globalThis as HealTeardownGlobal;
  const hook = g.__heal_teardown_hook;
  g.__heal_teardown_hook = undefined;
  if (typeof hook !== 'function') return;
  try {
    await hook();
  } catch (err) {
    console.error('[heal-playwright-tracer] teardown hook failed:', err);
  }
}
