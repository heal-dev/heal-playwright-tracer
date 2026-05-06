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
// Output shape (per (test, attempt)):
//   <cwd>/heal-traces/<executionId>/<playwrightTestId>/<attempt>/heal-traces.ndjson
// The fixture writes the ndjson + per-statement screenshots there;
// the reporter additionally copies Playwright artefacts (trace.zip,
// videos, failure screenshots, user attachments) into the same dir
// on `onTestEnd`. See
// `../../domain/trace-event-recorder/model/statement-trace-schema.ts`
// for the record contract.
//
// Any backend integration (HTTP shipping, APM bindings,
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
import { HealTracesLayout, resolveExecutionId } from '../../infrastructure/heal-traces-layout';
import { ArtifactSummaryPrinter } from '../../infrastructure/artifact-summary-printer';
import { healPendingRegistryPath } from '../../infrastructure/heal-reporter';

import { getTracerConfig, resetTeardownHooks, drainTeardownHooks } from '../heal-config';
import type { HealTracerTestContext, HealTestLifecycle } from '../heal-config';
import { withTimeout } from '../../util/with-timeout';

// Defaults for the optional `timeouts` block in `HealTracerConfig`.
// `screenshotMs` caps best-effort decoration calls in the screenshot
// pipeline; `lifecycleMs` caps user setup/teardown and the final
// projector close. On `lifecycleMs` timeouts the fixture logs to
// stderr and continues the rest of teardown — a hung user exporter
// must not block the next test from starting.
const DEFAULT_SCREENSHOT_TIMEOUT_MS = 1000;
const DEFAULT_LIFECYCLE_TIMEOUT_MS = 30_000;

// Wrap `expect` so any assertion made against a Locator gets a
// highlight screenshot stamped onto the active statement, the same
// way locator actions do. Non-locator assertions fall through.
const expect = wrapExpect(
  rawExpect as unknown as (...args: unknown[]) => unknown,
) as typeof rawExpect;

// All artefacts this package produces live under
// `<cwd>/heal-traces/<executionId>/<playwrightTestId>/<attempt>/`.
// `HealTracesLayout` owns the directory shape and filenames.

type TraceFixtures = {
  _traceAuto: void;
};

function buildHealTraceExporter(ndjsonPath: string, ctx: HealTracerTestContext): HealTraceExporter {
  const legs: HealTraceExporter[] = [new NdjsonExporter(ndjsonPath)];

  const { exporters = [] } = getTracerConfig();
  for (const factory of exporters) {
    try {
      legs.push(factory(ctx));
    } catch (err) {
      console.error('[heal-playwright-tracer] exporter factory failed:', err);
    }
  }

  return legs.length === 1 ? legs[0] : new CompositeHealTraceExporter(legs);
}

// Composition-root singletons — one per process.
const testContextAdapter = new PlaywrightTestContextAdapter({ setContext }, { resolveExecutionId });
const stepTrackingAdapter = new PlaywrightStepTrackingAdapter({ pushStep, popStep });

// The Babel plugin and the reporter are a pair — the in-worker fixture
// produces NDJSON; the reporter (main process) propagates the
// executionId, finalizes crashed traces, and copies Playwright
// artefacts. Running the plugin without the reporter silently produces
// half-broken output, so we hard-fail the first test in each worker.
// Reporter sets HEAL_TRACER_REPORTER=1 in onBegin; Playwright
// propagates env to workers.
let reporterCheckPassed = false;
function assertReporterRegistered(): void {
  if (reporterCheckPassed) return;
  if (process.env.HEAL_TRACER_REPORTER !== '1') {
    throw new Error(
      '@heal-dev/heal-playwright-tracer: Babel plugin is wired but the ' +
        'reporter is not registered. Add to playwright.config.ts:\n' +
        "  reporter: [['@heal-dev/heal-playwright-tracer/reporter']]\n" +
        'See https://github.com/heal-dev/heal-playwright-tracer#register-the-reporter',
    );
  }
  reporterCheckPassed = true;
}

export const test = base.extend<TraceFixtures>({
  _traceAuto: [
    async ({ page }, use, testInfo) => {
      assertReporterRegistered();
      const captured = testContextAdapter.capture(testInfo);

      const layout = new HealTracesLayout(process.cwd(), captured.executionId);
      const testDir = layout.testDir(captured.testId, captured.attempt);
      const ndjsonPath = layout.ndjsonPath(captured.testId, captured.attempt);
      const screenshotsDir = path.dirname(
        layout.screenshotPath(captured.testId, captured.attempt, 'x.png'),
      );
      fs.mkdirSync(testDir, { recursive: true });
      fs.mkdirSync(screenshotsDir, { recursive: true });

      // Write a registry entry for the optional `HealTracerReporter`
      // so it can find this test's NDJSON from the main process.
      // Filesystem-based (not annotation/attachment) because
      // Playwright's IPC does not flush fixture-pushed annotations
      // on abrupt worker exit (OOM / SIGKILL / `process.exit()`) —
      // exactly the crash cases the reporter rescues. A file
      // written with writeSync before the test body runs survives
      // any subsequent abrupt exit. Cleaned up in the `finally`
      // block below on graceful teardown, so only crashed tests
      // leave an orphan for the reporter to pick up.
      const registryPath = healPendingRegistryPath(
        testInfo.project.outputDir,
        captured.testId,
        captured.attempt,
      );
      fs.mkdirSync(path.dirname(registryPath), { recursive: true });
      fs.writeFileSync(
        registryPath,
        JSON.stringify({
          ndjsonPath,
          rootDir: testDir,
          executionId: captured.executionId,
          playwrightOutputDir: testInfo.outputDir,
        }),
        'utf8',
      );

      const tracerCtx: HealTracerTestContext = {
        testInfo,
        healDataDir: testDir,
        transport: {
          testId: captured.testId,
          attempt: captured.attempt,
          executionId: captured.executionId,
          rootDir: testDir,
          healTracesFilePath: ndjsonPath,
        },
      };

      // Fresh output pipeline per test: build a HealTraceExporter (default
      // NDJSON leg + any user-configured exporters), wrap it in a
      // projector, install on the recorder, then reset() — which
      // clears projector state and emits the test-header record via
      // the buildMetaEvent call inside the recorder.
      const output = buildHealTraceExporter(ndjsonPath, tracerCtx);
      const projector = new StatementProjector(output);
      setExporter(projector);
      reset();

      // Defensive: clear any teardown hooks that leaked from a
      // previous test that crashed before drain ran.
      resetTeardownHooks();

      const { timeouts = {} } = getTracerConfig();
      const screenshotTimeoutMs = timeouts.screenshotMs ?? DEFAULT_SCREENSHOT_TIMEOUT_MS;
      const lifecycleTimeoutMs = timeouts.lifecycleMs ?? DEFAULT_LIFECYCLE_TIMEOUT_MS;

      const stopScreenshots = startLocatorScreenshotCapture(
        page,
        screenshotsDir,
        setCurrentStatementScreenshot,
        screenshotTimeoutMs,
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
          await withTimeout(
            Promise.resolve(lc.setup(tracerCtx)),
            lifecycleTimeoutMs,
            'lifecycle.setup',
          );
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
        try {
          await withTimeout(drainTeardownHooks(), lifecycleTimeoutMs, 'onTestTeardown hooks');
        } catch (err) {
          console.error('[heal-playwright-tracer] teardown hooks did not finish:', err);
        }

        // Teardown in reverse order (LIFO): the last lifecycle to set
        // up is the first to tear down, matching the mental model of
        // nested `using` blocks.
        for (let i = activeLifecycles.length - 1; i >= 0; i--) {
          try {
            await withTimeout(
              Promise.resolve(activeLifecycles[i].teardown()),
              lifecycleTimeoutMs,
              'lifecycle.teardown',
            );
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
        // Pass testInfo.errors[0] so any root statement whose __enter
        // fired but whose __ok/__throw never did (Playwright aborted
        // the hanging action on timeout before the catch block could
        // run) gets flushed as `threw` with the test-level error.
        const pendingError = testInfo.errors[0] ?? testInfo.error;
        try {
          await withTimeout(
            projector.finalize(
              {
                status: testInfo.status ?? 'passed',
                duration: testInfo.duration,
                stdout: capturedStdout.stdout.length ? capturedStdout.stdout : undefined,
                stderr: capturedStdout.stderr.length ? capturedStdout.stderr : undefined,
              },
              pendingError,
            ),
            lifecycleTimeoutMs,
            'projector.finalize',
          );
        } catch (err) {
          // The trace may be truncated (final test-result record
          // and exporter close didn't complete in time) but the
          // test itself has already finished — keep going so
          // downstream registry cleanup still runs.
          console.error('[heal-playwright-tracer] projector.finalize did not finish:', err);
        }

        new ArtifactSummaryPrinter(testDir).print({
          title: testInfo.title,
          status: testInfo.status ?? 'passed',
        });

        // Registry cleanup is owned by `HealTracerReporter` — it
        // runs on clean teardowns too because Playwright populates
        // `result.attachments` only after this fixture's afterEach
        // returns, so the reporter is the first hook with a final
        // attachment list. It appends a `test-attachments` record
        // and then deletes the registry entry.
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
