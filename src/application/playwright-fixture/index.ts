/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Composition root for the heal-playwright-tracer auto-fixture.
//
// Each feature owns its own setup/cleanup; this file is the shopping
// list. Reading top-to-bottom tells you everything the tracer does to
// a test and in what order.
//
// Built-in features wired here (always-on, OSS):
//   - runtime (side-effect import installs globalThis.__heal_enter/__heal_ok/__heal_throw)
//   - step-tracking       → new PlaywrightStepTrackingAdapter(hooks).patch(test)
//   - test-context        → testContextAdapter.capture(testInfo)
//   - locator-screenshots → startLocatorScreenshotCapture(page, outDir)
//   - test-stdout-capture → new StdoutCaptureSession()
//   - NDJSON exporter         → default trace output to `heal-data/heal-traces.ndjson`
//
// User-extensible features (wired via `configureTracer(...)` from the
// host `playwright.config.ts`):
//   - exporters       → each factory returns a `HealTraceExporter` composed
//                   into a tee alongside the default NDJSON exporter
//   - lifecycles  → each entry exposes `setup(ctx)` + `teardown()`;
//                   setups run in declaration order at test start,
//                   teardowns in reverse order in `finally` (LIFO)
//   - onTestTeardown(fn) → runtime registration, drained before
//                   lifecycle teardowns so SDKs still see any globals
//                   a lifecycle installed
//
// Output shape (per test): `heal-data/heal-traces.ndjson` — one
// HealTraceRecord per line. See
// `../../domain/trace-event-recorder/model/statement-trace-schema.ts`
// for the contract.
//
// Env toggles:
//   HEAL_TRACE_NDJSON   default on; set to `0`/`false`/`off` to disable.
//
// Any backend integration (live-collector HTTP shipping, APM bindings,
// telemetry-session setup, …) lives in user code and plugs in via
// `configureTracer`. The fixture knows nothing about any specific
// backend.

import * as fs from 'fs';
import * as path from 'path';
import { expect as rawExpect, test as base } from '@playwright/test';
// Side-effect: installs `globalThis.__heal_enter/__heal_ok/__heal_throw`.
import {
  reset,
  setExporter,
  setContext,
  pushStep,
  popStep,
  setCurrentStatementScreenshot,
} from '../trace-event-recorder-runtime';
import { wrapExpect } from '../../infrastructure/playwright-locator-screenshot-adapter';
import { StatementProjector } from '../../domain/trace-event-recorder/service/projectors';
import { NdjsonExporter } from '../../infrastructure/ndjson-exporter-adapter';
import { CompositeHealTraceExporter } from '../../domain/trace-event-recorder/service';
import type { HealTraceExporter } from '../../domain/trace-event-recorder/port/heal-trace-exporter';

import { PlaywrightStepTrackingAdapter } from '../../infrastructure/playwright-step-tracking-adapter';
import { PlaywrightTestContextAdapter } from '../../infrastructure/playwright-test-context-adapter';
import { startLocatorScreenshotCapture } from '../../infrastructure/playwright-locator-screenshot-adapter';
import { StdoutCaptureSession } from '../../infrastructure/stdout-capture-adapter';

import { getTracerConfig, resetTeardownHooks, drainTeardownHooks } from '../heal-config';
import type { HealTracerTestContext, HealTestLifecycle } from '../heal-config';

// Wrap `expect` so any assertion made against a Locator gets a
// highlight screenshot stamped onto the active statement, the same
// way locator actions do. Non-locator assertions fall through.
const expect = wrapExpect(
  rawExpect as unknown as (...args: unknown[]) => unknown,
) as typeof rawExpect;

// All artifacts this package produces live under this subdirectory of
// `testInfo.outputDir`, so they stay segregated from Playwright's own
// output (screenshot/trace/video attachments).
const HEAL_DATA_SUBDIR = 'heal-data';
const NDJSON_FILENAME = 'heal-traces.ndjson';

type TraceFixtures = {
  _traceAuto: void;
};

function envFlag(name: string, defaultOn: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultOn;
  const v = raw.toLowerCase();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  return true;
}

function buildHealTraceExporter(
  healDataDir: string,
  ctx: HealTracerTestContext,
): HealTraceExporter {
  const legs: HealTraceExporter[] = [];

  if (envFlag('HEAL_TRACE_NDJSON', true)) {
    legs.push(new NdjsonExporter(path.join(healDataDir, NDJSON_FILENAME)));
  }

  const { exporters = [] } = getTracerConfig();
  for (const factory of exporters) {
    try {
      legs.push(factory(ctx));
    } catch (err) {
      console.error('[heal-playwright-tracer] exporter factory failed:', err);
    }
  }

  if (legs.length === 0) {
    // Neither leg active — return a no-op exporter so the projector
    // still runs without doing anything user-visible.
    return { write() {}, async close() {} };
  }
  return legs.length === 1 ? legs[0] : new CompositeHealTraceExporter(legs);
}

// Composition-root singletons — one per process.
const testContextAdapter = new PlaywrightTestContextAdapter({ setContext });
const stepTrackingAdapter = new PlaywrightStepTrackingAdapter({ pushStep, popStep });

export const test = base.extend<TraceFixtures>({
  _traceAuto: [
    async ({ page }, use, testInfo) => {
      const captured = testContextAdapter.capture(testInfo);

      const healDataDir = path.join(testInfo.outputDir, HEAL_DATA_SUBDIR);
      fs.mkdirSync(healDataDir, { recursive: true });

      const tracerCtx: HealTracerTestContext = {
        testInfo,
        healDataDir,
        transport: {
          testId: captured.testId,
          attempt: captured.attempt,
          rootDir: testInfo.outputDir,
        },
      };

      // Fresh output pipeline per test: build a HealTraceExporter (default
      // NDJSON leg + any user-configured exporters), wrap it in a
      // projector, install on the recorder, then reset() — which
      // clears projector state and emits the test-header record via
      // the buildMetaEvent call inside the recorder.
      const output = buildHealTraceExporter(healDataDir, tracerCtx);
      const projector = new StatementProjector(output);
      setExporter(projector);
      reset();

      // Defensive: clear any teardown hooks that leaked from a
      // previous test that crashed before drain ran.
      resetTeardownHooks();

      const stopScreenshots = startLocatorScreenshotCapture(
        page,
        healDataDir,
        setCurrentStatementScreenshot,
      );
      const stdoutSession = new StdoutCaptureSession();

      // Instantiate user-configured lifecycles for this test. Each
      // factory runs fresh per test so any closure state the factory
      // declares is isolated between tests. Setup failures are
      // isolated: a lifecycle whose `setup` throws is NOT pushed onto
      // `activeLifecycles`, so its `teardown` will not run. Later
      // lifecycles still get a chance to set up.
      const activeLifecycles: HealTestLifecycle[] = [];
      const { lifecycles = [] } = getTracerConfig();
      for (const factory of lifecycles) {
        try {
          const lc = factory();
          await lc.setup(tracerCtx);
          activeLifecycles.push(lc);
        } catch (err) {
          console.error('[heal-playwright-tracer] lifecycle setup failed:', err);
        }
      }

      try {
        await use();
      } finally {
        // Run any teardown hooks registered during the test. Runs
        // BEFORE lifecycle teardowns so hooks that log via an SDK
        // still see the per-test globals a lifecycle installed, and
        // BEFORE stopping stdout capture so SDK teardown output lands
        // in the ndjson's `test-result.stdout/stderr`.
        await drainTeardownHooks();

        // Teardown in reverse order (LIFO): the last lifecycle to set
        // up is the first to tear down, matching the mental model of
        // nested `using` blocks.
        for (let i = activeLifecycles.length - 1; i >= 0; i--) {
          try {
            await activeLifecycles[i].teardown();
          } catch (err) {
            console.error('[heal-playwright-tracer] lifecycle teardown failed:', err);
          }
        }

        const capturedStdout = stdoutSession.stop();
        stopScreenshots();

        // Emit the final test-result record and close the output
        // exporter chain (flushes NDJSON fd, awaits in-flight
        // user-exporter I/O). The projector has its own `finalized`
        // guard that silently swallows any stray events fired after
        // this point, so we do NOT swap the recorder's exporter back
        // to a no-op — it stays pointed at the (now-finalized)
        // projector until the next test installs a fresh one.
        //
        // Playwright-native artifacts (trace.zip, videos) are NOT
        // shipped from here — their attachments are populated by
        // Playwright in a later phase. Users who need them can
        // register a Playwright reporter in their `playwright.config`.
        await projector.finalize({
          status: testInfo.status ?? 'passed',
          duration: testInfo.duration,
          stdout: capturedStdout.stdout.length ? capturedStdout.stdout : undefined,
          stderr: capturedStdout.stderr.length ? capturedStdout.stderr : undefined,
        });
      }
    },
    { auto: true },
  ],
});

// Thread test.step titles onto the runtime step stack. Must run AFTER
// base.extend because Playwright's extend creates a fresh `.step` on
// the new test object that doesn't inherit from base — patching `base`
// first would never reach the extended test.
stepTrackingAdapter.patch(test);

export { expect };

// Re-export `reset` so callers that manage the recorder state
// themselves (rare; tests mostly) can trigger a fresh session.
export { reset };
