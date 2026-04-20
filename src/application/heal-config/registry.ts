// Module-local registry that backs the `configureTracer()` /
// `onTestTeardown()` public API.
//
// Why module-local and not `globalThis`: each Playwright worker
// process imports `playwright.config.ts` on startup, which in turn
// calls `configureTracer(cfg)` — so each worker owns its own copy of
// `currentConfig`. No cross-worker state to worry about, no global
// namespace collision with a host app.
//
// Runtime teardown hooks (`onTestTeardown`) use a per-process array
// that is explicitly reset at the start of every test by the fixture
// (`resetTeardownHooks`) and drained in `finally`
// (`drainTeardownHooks`). One slot per hook; callers can register
// multiple hooks from anywhere during the test.

import type { HealTracerConfig } from './types';

let currentConfig: HealTracerConfig = {};
let teardownHooks: Array<() => void | Promise<void>> = [];

/**
 * Register the tracer's extension config. Typically called once at
 * the top of `playwright.config.ts`, before `defineConfig(...)`. Later
 * calls overwrite earlier ones — there is no merge.
 */
export function configureTracer(config: HealTracerConfig): void {
  currentConfig = config;
}

/**
 * Read the currently-registered config. Returns an empty object when
 * the user never called `configureTracer` — the fixture treats that
 * as "NDJSON-only, no bindings."
 */
export function getTracerConfig(): HealTracerConfig {
  return currentConfig;
}

/**
 * Register a function to run when the current test tears down. Runs
 * BEFORE user bindings' `stop()` so SDKs that use
 * `onTestTeardown(...)` still see any globals the bindings installed.
 *
 * Errors raised by a hook are logged to stderr and swallowed.
 */
export function onTestTeardown(fn: () => void | Promise<void>): void {
  teardownHooks.push(fn);
}

/**
 * Internal. Clears the teardown-hook registry. The fixture calls this
 * at the start of every test to defend against a hook leaking across
 * test boundaries if a prior test crashed before drain ran.
 */
export function resetTeardownHooks(): void {
  teardownHooks = [];
}

/**
 * Internal. Runs every registered teardown hook in registration order,
 * then clears the registry. Errors are logged and swallowed.
 */
export async function drainTeardownHooks(): Promise<void> {
  const hooks = teardownHooks;
  teardownHooks = [];
  for (const hook of hooks) {
    try {
      await hook();
    } catch (err) {
      console.error('[heal-playwright-tracer] teardown hook failed:', err);
    }
  }
}
