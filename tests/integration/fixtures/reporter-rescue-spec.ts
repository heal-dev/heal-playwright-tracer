/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// The Playwright spec driven by `reporter-rescue.test.ts`.
//
// Three tests, each exercising one of the three "where does the
// `test-result` come from?" paths the tracer supports:
//
//   1. clean-pass            → fixture's projector.finalize writes
//                               the terminator; reporter is a no-op.
//                               Baseline / regression guard.
//   2. worker-crash          → process.exit(1) kills the worker
//                               synchronously. Fixture's `finally`
//                               never runs; reporter's `onTestEnd`
//                               reads the registry file left on disk
//                               and appends a synthetic `test-result`
//                               with `error.name = "WorkerCrash"`.
//   3. playwright-timeout    → test hangs past its own timeout.
//                               Fixture's `finally` DOES run and
//                               invokes `flushPendingRoots` with
//                               `testInfo.errors[0]`, emitting the
//                               hanging root as `status: "threw"`
//                               with the timeout error attached.
//
// `page` is NOT imported: the tests don't need a browser, and
// keeping the spec browser-free shaves ~10s per run.

export const REPORTER_RESCUE_SPEC = `import { test, expect } from '@playwright/test';

test('clean-pass', async () => {
  const x = 1;
  const y = 2;
  expect(x + y).toBe(3);
});

test('worker-crash', async () => {
  // At least one real statement before the crash so we can prove
  // the instrumentation was wired in before the worker died.
  const before = 1;
  void before;
  process.exit(1);
});

test('playwright-timeout', async () => {
  // Per-test timeout override. Short enough to keep the integration
  // run fast; long enough that the warmup statement completes and
  // is flushed as status=ok before the pending Promise is aborted.
  test.setTimeout(1500);
  const warmup = 1;
  void warmup;
  // Hangs forever. Playwright aborts this awaited Promise at
  // t=1500ms; the fixture's \`finally\` picks up the pending root.
  await new Promise(() => {});
});
`;
