/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// End-to-end coverage for the three "who wrote the test-result
// terminator?" paths in the tracer. See `../fixtures/reporter-rescue-spec.ts`
// for the three scenarios driven here.
//
// Scaffolds one sandbox with the crash-rescue reporter registered in
// `playwright.config.ts`, runs `npx playwright test`, then parses the
// per-test NDJSON files off disk and asserts on the shape of the
// `test-result` record (and, for the timeout scenario, on the
// presence of a `status: "threw"` pending-root flush).
//
// The three test titles match the per-test Playwright titles in the
// sandbox spec. Bundling the three into one Playwright run amortizes
// the install + worker startup cost — a separate sandbox per
// scenario would triple the integration suite runtime for no extra
// signal.

import { beforeAll, describe, it, expect } from 'vitest';
import { IntegrationSandbox } from '../bootstrap/integration-sandbox';
import { DiskTraceReader } from '../bootstrap/test-doubles/disk-trace-reader';
import { REPORTER_RESCUE_SPEC } from '../fixtures/reporter-rescue-spec';
import { findStatement, type ParsedTrace } from '../fixtures/parsed-trace';

let traces: Map<string, ParsedTrace>;

beforeAll(async () => {
  const tarballPath = process.env.INTEGRATION_TARBALL;
  if (!tarballPath) throw new Error('INTEGRATION_TARBALL not set — globalSetup failed?');

  const sandbox = new IntegrationSandbox({
    tarballPath,
    specSource: REPORTER_RESCUE_SPEC,
    withHealReporter: true,
  });
  sandbox.scaffold();
  sandbox.install();
  // Exit code 1 is expected: two of the three scenarios fail on
  // purpose (worker crash, test timeout). `runPlaywright` already
  // tolerates that.
  await sandbox.runPlaywright();

  traces = new DiskTraceReader().collect(sandbox.getRoot());
  if (traces.size === 0) {
    throw new Error('No traces collected from disk — did the sandbox spec run at all?');
  }
});

function getTrace(title: string): ParsedTrace {
  const trace = traces.get(title);
  if (!trace) {
    const available = [...traces.keys()].join(', ') || '(none)';
    throw new Error(`No trace found for "${title}". Available titles: ${available}`);
  }
  return trace;
}

describe('integration: HealTracerReporter end-to-end', () => {
  it('clean-pass: fixture writes the terminator, reporter stays silent', () => {
    const trace = getTrace('clean-pass');
    expect(trace.schemaVersion).toBe(1);
    expect(trace.test.status).toBe('passed');
    // Reporter-synthesized test-results ALWAYS carry `error`. The
    // fixture-written terminator on a clean pass never does — this
    // is the discriminator that proves the reporter was a no-op.
    expect(trace.test.error).toBeUndefined();

    // The `const x = 1` statement was captured with its var snapshot.
    const varStmt = findStatement(trace, (s) => s.source.includes('const x = 1'));
    expect(varStmt).toBeDefined();
    expect(varStmt!.vars).toEqual({ x: 1 });
    expect(varStmt!.status).toBe('ok');
  });

  it('worker-crash: reporter rescues the NDJSON and stamps WorkerCrash', () => {
    const trace = getTrace('worker-crash');
    expect(trace.schemaVersion).toBe(1);

    // The synthetic test-result MUST carry `error` — that's how we
    // know it came from the reporter's main-process rescue path
    // rather than from the fixture (the fixture would never write
    // one, since `process.exit(1)` killed the worker before
    // `projector.finalize` could fire).
    expect(trace.test.error).toBeDefined();
    expect(trace.test.error?.name).toBe('WorkerCrash');
    expect(trace.test.error?.message).toMatch(/worker process exited unexpectedly/i);

    // Playwright's own status for a crashed worker.
    expect(trace.test.status).toBe('failed');

    // At least one instrumented statement ran before the crash —
    // the Babel injector and in-worker exporter pipeline worked up
    // to the moment process.exit fired.
    const beforeStmt = findStatement(trace, (s) => s.source.includes('const before = 1'));
    expect(beforeStmt).toBeDefined();
    expect(beforeStmt!.vars).toEqual({ before: 1 });
    expect(beforeStmt!.status).toBe('ok');
  });

  it('playwright-timeout: fixture flushes the pending root with the test-level timeout error', () => {
    const trace = getTrace('playwright-timeout');
    expect(trace.schemaVersion).toBe(1);

    // Playwright aborts the test body, so the test-result carries
    // status=timedOut. The fixture wrote this record (`error`
    // absent), not the reporter — distinguishes this path from the
    // worker-crash path asserted above.
    expect(trace.test.status).toBe('timedOut');
    expect(trace.test.error).toBeUndefined();

    // The warmup root completed normally and is flushed as ok.
    const warmupStmt = findStatement(trace, (s) => s.source.includes('const warmup = 1'));
    expect(warmupStmt).toBeDefined();
    expect(warmupStmt!.status).toBe('ok');

    // The hanging `new Promise(() => {})` root had its __enter fire
    // but no __ok/__throw — `flushPendingRoots` in finalize() stamps
    // it as `threw` with the test-level timeout error. This is the
    // load-bearing assertion: no other code path produces a
    // status=threw statement record with a timeout message.
    const pendingStmt = findStatement(trace, (s) => s.source.includes('new Promise'));
    expect(pendingStmt).toBeDefined();
    expect(pendingStmt!.status).toBe('threw');
    expect(pendingStmt!.error?.message).toMatch(/Test timeout of 1500ms exceeded|has been closed/i);
  });
});
