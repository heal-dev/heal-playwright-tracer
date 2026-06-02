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

import * as fs from 'fs';
import * as path from 'path';
import { beforeAll, describe, it, expect } from 'vitest';
import { IntegrationSandbox } from '../bootstrap/integration-sandbox';
import { DiskTraceReader } from '../bootstrap/test-doubles/disk-trace-reader';
import { REPORTER_RESCUE_SPEC } from '../fixtures/reporter-rescue-spec';
import { findStatement, type ParsedTrace } from '../fixtures/parsed-trace';
import type { ExecutionManifest } from '../../../src/domain/persistence';

let traces: Map<string, ParsedTrace>;
let manifest: ExecutionManifest;
let sandboxRoot: string;

/**
 * Walk `<root>/heal-traces/<executionId>/execution.json`. The reporter
 * writes exactly one per run (single executionId in the sandbox).
 */
function readExecutionManifest(root: string): ExecutionManifest {
  const healTracesDir = path.join(root, 'heal-traces');
  for (const entry of fs.readdirSync(healTracesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(healTracesDir, entry.name, 'execution.json');
    if (fs.existsSync(candidate)) {
      return JSON.parse(fs.readFileSync(candidate, 'utf8')) as ExecutionManifest;
    }
  }
  throw new Error('No execution.json found under heal-traces/');
}

beforeAll(async () => {
  const tarballPath = process.env.INTEGRATION_TARBALL;
  if (!tarballPath) throw new Error('INTEGRATION_TARBALL not set — globalSetup failed?');

  const sandbox = new IntegrationSandbox({
    tarballPath,
    specSource: REPORTER_RESCUE_SPEC,
  });
  sandbox.scaffold();
  sandbox.install();
  // Exit code 1 is expected: three of the four scenarios fail on
  // purpose (worker crash, test timeout, statement throw).
  // `runPlaywright` already tolerates that.
  await sandbox.runPlaywright();

  sandboxRoot = sandbox.getRoot();
  traces = new DiskTraceReader().collect(sandboxRoot);
  if (traces.size === 0) {
    throw new Error('No traces collected from disk — did the sandbox spec run at all?');
  }
  manifest = readExecutionManifest(sandboxRoot);
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
    expect(trace.schemaVersion).toBe(3);
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
    expect(trace.schemaVersion).toBe(3);

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
    expect(trace.schemaVersion).toBe(3);

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

  // The `onFailingStatement` hook is a constructor dep of
  // HealTracerReporter. The sandbox registers the reporter by module
  // path (`@heal-dev/heal-playwright-tracer/reporter`), so Playwright
  // instantiates it with NO deps — there is no seam to inject a hook
  // or observe its callback from this (parent) process. So we assert
  // on the durable on-disk projection the hook is fed from: the
  // attempt's `failingStatement` + `error` in execution.json. These
  // are populated in the SAME `if (found)` branch that fires the hook
  // (`invokeFailingStatementHook(found.statement, found.error, …)`),
  // so their presence with the right raw fields proves that branch —
  // and therefore the hook site — was reached for this attempt.
  it('statement-throw: located failing statement is persisted onto the attempt (hook-fed record)', () => {
    // The per-test NDJSON shows the statement threw end-to-end.
    const trace = getTrace('statement-throw');
    expect(trace.test.status).toBe('failed');
    const threwStmt = findStatement(trace, (s) => s.source.includes('boom from instrumented'));
    expect(threwStmt).toBeDefined();
    expect(threwStmt!.status).toBe('threw');

    // execution.json carries the located failing statement + error on
    // the attempt — exactly the raw record the onFailingStatement hook
    // ships (`{ failingStatement, error }`) plus the (test, attempt)
    // correlation the ctx carries (`playwrightTestId`, `attempt`).
    const entry = manifest.tests.find((t) => t.title === 'statement-throw');
    expect(entry).toBeDefined();
    expect(typeof entry!.playwrightTestId).toBe('string');
    expect(entry!.playwrightTestId.length).toBeGreaterThan(0);

    const attempt = entry!.attempts.find((a) => a.attempt === 1);
    expect(attempt).toBeDefined();
    expect(attempt!.status).toBe('failed');

    // The failingStatement is RAW (index/file/line/source/scope) —
    // the wire is policy-free, matching the hook record contract.
    expect(attempt!.failingStatement).toBeDefined();
    const fs = attempt!.failingStatement!;
    expect(typeof fs.index).toBe('number');
    expect(fs.file).toMatch(/scenarios\.spec\.ts$/);
    expect(typeof fs.line).toBe('number');
    expect(fs.source).toContain('boom from instrumented statement');

    // The error is the raw StatementError the hook ships alongside.
    expect(attempt!.error).toBeDefined();
    expect(attempt!.error!.message).toContain('boom from instrumented statement');
  });
});
