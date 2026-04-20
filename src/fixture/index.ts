// Composition root for the heal-playwright-tracer auto-fixture.
//
// Each feature owns its own setup/cleanup; this file is the shopping
// list. Reading top-to-bottom tells you everything the tracer does to
// a test and in what order.
//
// Features wired here:
//   - runtime (side-effect import installs globalThis.__heal_enter/__heal_ok/__heal_throw)
//   - step-tracking       → patchTestStep(test)
//   - test-context        → captureTestContext(testInfo)
//   - locator-screenshots → startLocatorScreenshotCapture(page, outDir)
//   - test-stdout-capture → startStdoutCapture()
//   - langfuse-binding    → startLangfuseBinding(testInfo)
//   - teardown-hook       → runTeardownHook() in `finally` — invokes
//                           whatever `globalThis.__heal_teardown_hook`
//                           contains (currently wired by heal-cli to
//                           `Heal.close()`). No-op when unset.
//   - trace output        → streaming statement-projector →
//                           TeeSink(NdjsonSink, AgentHttpSink)
//
// Output shape (per test): `heal-data/heal-traces.ndjson` — one
// HealTraceRecord per line. See
// `../features/trace-output/statement-trace-schema.ts` for the
// contract. The NDJSON file is the durable record of truth; the
// collector leg is best-effort and auto-enabled when the Docker
// entrypoint sets `HEAL_COLLECTOR_URL`.
//
// Env toggles for the output pipeline:
//   HEAL_TRACE_NDJSON     default on; set to `0`/`false`/`off` to disable.
//   HEAL_COLLECTOR_URL    base URL of the pod-scoped heal-trace-collector
//                         (e.g. `http://127.0.0.1:9999`). When set, trace
//                         records are shipped live to the collector in
//                         addition to the NDJSON file. Unset = NDJSON only.

import * as fs from 'fs';
import * as path from 'path';
import { expect as rawExpect, test as base } from '@playwright/test';
// Side-effect: installs `globalThis.__heal_enter/__heal_ok/__heal_throw`.
import { reset, setSink } from '../trace-event-recorder/entrypoint';
import { wrapExpect } from '../features/locator-screenshots';
import { createStatementProjectorSink } from '../trace-event-recorder/projectors/statement-projector';
import { createNdjsonSink } from '../trace-event-recorder/adapters/ndjson-sink';
import { createCollectorHttpSink } from '../trace-event-recorder/adapters/collector-http-sink';
import { createTeeSink } from '../trace-event-recorder/adapters/tee-sink';
import { createMemorySink } from '../trace-event-recorder/adapters/memory-sink';
import type { HealTraceSink } from '../trace-event-recorder/ports/heal-trace-sink';

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

import { patchTestStep } from '../features/step-tracking';
import { captureTestContext } from '../features/test-context';
import { startLocatorScreenshotCapture } from '../features/locator-screenshots';
import { startStdoutCapture } from '../features/test-stdout-capture';
import { startLangfuseBinding } from '../features/langfuse-binding';
import { runTeardownHook } from '../features/teardown-hook';

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

function buildHealTraceSink(
  healDataDir: string,
  rootDir: string,
  transport: { runId: string; attempt: number },
): HealTraceSink {
  const legs: HealTraceSink[] = [];

  if (envFlag('HEAL_TRACE_NDJSON', true)) {
    legs.push(createNdjsonSink(path.join(healDataDir, NDJSON_FILENAME)));
  }

  const collectorUrl = process.env.HEAL_COLLECTOR_URL;
  if (collectorUrl) {
    legs.push(
      createCollectorHttpSink({
        url: collectorUrl,
        transport: { runId: transport.runId, attempt: transport.attempt, rootDir },
      }),
    );
  }

  if (legs.length === 0) {
    // Neither leg active — return a no-op sink so the projector
    // still runs without doing anything user-visible.
    return { write() {}, async close() {} };
  }
  return legs.length === 1 ? legs[0] : createTeeSink(legs);
}

export const test = base.extend<TraceFixtures>({
  _traceAuto: [
    async ({ page }, use, testInfo) => {
      const captured = captureTestContext(testInfo);

      const healDataDir = path.join(testInfo.outputDir, HEAL_DATA_SUBDIR);
      fs.mkdirSync(healDataDir, { recursive: true });

      // Fresh output pipeline per test: build a HealTraceSink from
      // env flags, wrap it in a projector, install on the recorder,
      // then reset() — which clears projector state and emits the
      // test-header record via the buildMetaEvent call inside the
      // recorder.
      const output = buildHealTraceSink(healDataDir, testInfo.outputDir, {
        runId: captured.runId,
        attempt: captured.attempt,
      });
      const projector = createStatementProjectorSink(output);
      setSink(projector);
      reset();

      const stopScreenshots = startLocatorScreenshotCapture(page, healDataDir);
      const stdoutSession = startStdoutCapture();
      const langfuseBinding = startLangfuseBinding(testInfo);

      try {
        await use();
      } finally {
        // Run any teardown hook registered during the test (e.g. by
        // heal-cli's `Heal.attachToPage`). Runs BEFORE stopping stdout
        // capture so any SDK teardown output lands in the ndjson's
        // `test-result.stdout/stderr`, and BEFORE `langfuseBinding.stop`
        // so hooks that log via the SDK still see the per-test
        // session/trace-name globals.
        await runTeardownHook();

        langfuseBinding.stop();

        const capturedStdout = stdoutSession.stop();
        stopScreenshots();

        // Emit the final test-result record and close the output
        // sink (flushes NDJSON fd, awaits in-flight collector POSTs).
        // Playwright-native artifacts (trace.zip, videos) are NOT
        // shipped from here — their attachments are populated by
        // Playwright in a later phase. `HealArtifactReporter`
        // handles them from `onTestEnd`.
        await projector.finalize({
          status: testInfo.status ?? 'passed',
          duration: testInfo.duration,
          stdout: capturedStdout.stdout.length ? capturedStdout.stdout : undefined,
          stderr: capturedStdout.stderr.length ? capturedStdout.stderr : undefined,
        });

        // Restore a detached MemorySink so any stray events fired
        // after teardown (rare but possible during fixture cleanup)
        // don't land on a finalized projector.
        setSink(createMemorySink());
      }
    },
    { auto: true },
  ],
});

// Thread test.step titles onto the runtime step stack. Must run AFTER
// base.extend because Playwright's extend creates a fresh `.step` on
// the new test object that doesn't inherit from base — patching `base`
// first would never reach the extended test.
patchTestStep(test);

export { expect };

// Re-export runtime introspection so tests or a custom reporter can
// read the in-memory buffer mid-test. Note that in the NDJSON path
// this returns an empty array (the projector doesn't retain a flat
// event log); `snapshot()` is only useful when a MemorySink is the
// active sink, e.g. in unit tests.
export { snapshot, reset } from '../trace-event-recorder/entrypoint';
