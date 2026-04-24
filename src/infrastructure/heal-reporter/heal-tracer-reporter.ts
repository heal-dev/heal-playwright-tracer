/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Optional Playwright `Reporter` that runs in the MAIN process and
// rescues per-test NDJSON files when the worker dies before the
// fixture's teardown can finalize them.
//
// Crash paths the fixture cannot handle on its own (worker OOM,
// SIGKILL, segfault, `process.exit()`): the fixture's `finally`
// block never runs, so `projector.finalize(...)` never writes the
// `test-result` terminator. The NDJSON is left open-ended, and
// consumers cannot tell whether the test crashed or the file is
// simply still being written.
//
// This reporter subscribes to `onTestEnd` — which fires even for
// tests whose worker died, because Playwright fabricates the result
// from the main-process side. It:
//
//   1. Resolves the per-test NDJSON path + outputDir from the
//      `HEAL_TRACE_CONTEXT_ANNOTATION` the fixture registers at
//      test start. Using an annotation (not a computed path) means
//      this reporter never has to duplicate `HealDataLayout`'s
//      layout logic and stays correct under any user `outputDir`
//      config.
//   2. Early-returns if the NDJSON is missing (tracer not wired
//      for this test) or already ends with `test-result` (fixture
//      finalized cleanly — normal case).
//   3. Classifies the crash via `CrashErrorClassifier` using the
//      worker's stderr buffer and `TestResult.errors`, then appends
//      a synthetic `test-result` line with the classified error.
//   4. If an `onRescue` hook is configured, invokes it (fire-and-
//      forget) so extension code — e.g. the sidecar's live
//      collector leg — can observe the rescued record. Under
//      nominal teardown the live collector already sees every
//      statement/test-result record via the tracer's exporter
//      chain; only the crashed-worker case needs this hook because
//      the in-worker exporters never got to send it.
//
// Registration (user-facing, in `playwright.config.ts`):
//
//   reporter: [['@heal-dev/heal-playwright-tracer/reporter']]
//
// The reporter is pure-optional: when the fixture's own teardown
// runs to completion (by far the common case), the reporter is a
// no-op. Users who don't register it simply don't get the crash
// rescue.

import * as fs from 'fs';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import type {
  TestResultRecord,
  StatementError,
} from '../../domain/trace-event-recorder/model/statement-trace-schema';
import { CrashErrorClassifier } from './crash-error-classifier';
import { NdjsonTailInspector } from './ndjson-tail-inspector';

/**
 * Annotation type written by the fixture at test start so the
 * reporter knows which NDJSON file belongs to which test and what
 * the surrounding Playwright outputDir is. The `description` is a
 * JSON-encoded `HealTraceContext`. Matches the constant used in
 * `src/application/playwright-fixture/index.ts`.
 */
export const HEAL_TRACE_CONTEXT_ANNOTATION = 'heal-trace-context';

export interface HealTraceContext {
  /** Absolute path to the per-test `heal-traces.ndjson`. */
  ndjsonPath: string;
  /** Absolute `testInfo.outputDir` — the root of the per-test artifact dir. */
  rootDir: string;
}

/**
 * Context handed to the `onRescue` hook. Extends `HealTraceContext`
 * with the per-test correlation fields the hook needs to route the
 * synthetic record (matches the transport envelope used by the
 * sidecar's live collector path).
 */
export interface RescueContext extends HealTraceContext {
  /** Playwright `TestCase.id` — stable hash of (file, title, project). */
  testId: string;
  /** 1-indexed attempt number = `TestResult.retry + 1`. */
  attempt: number;
  /** `TestResult.workerIndex` where the crash happened. */
  workerIndex: number;
}

/**
 * Invoked after the reporter has appended its synthetic
 * `test-result` to the NDJSON. Intended for extensions that need to
 * forward the rescued record to a live destination the in-worker
 * exporters never got to reach (e.g. the sidecar's collector HTTP
 * path, which runs per-test inside the worker and therefore dies
 * with it).
 *
 * Errors are caught by the reporter and logged to `process.stderr`;
 * a failing hook never breaks the Playwright run or prevents the
 * on-disk append from landing.
 */
export type RescueHook = (record: TestResultRecord, ctx: RescueContext) => void | Promise<void>;

export interface HealTracerReporterDeps {
  classifier?: CrashErrorClassifier;
  inspector?: NdjsonTailInspector;
  /**
   * Seam for tests — defaults to `fs.appendFileSync`. Kept sync so
   * the synthetic line hits disk before the reporter returns, same
   * crash-safety discipline as `NdjsonExporter`.
   */
  appendFile?: (path: string, data: string) => void;
  onRescue?: RescueHook;
}

export class HealTracerReporter implements Reporter {
  private readonly classifier: CrashErrorClassifier;
  private readonly inspector: NdjsonTailInspector;
  private readonly appendFile: (path: string, data: string) => void;
  private readonly onRescue: RescueHook | null;
  private readonly stderrByWorker = new Map<number, string[]>();

  constructor(deps: HealTracerReporterDeps = {}) {
    this.classifier = deps.classifier ?? new CrashErrorClassifier();
    this.inspector = deps.inspector ?? new NdjsonTailInspector();
    this.appendFile = deps.appendFile ?? ((p, d) => fs.appendFileSync(p, d, { encoding: 'utf8' }));
    this.onRescue = deps.onRescue ?? null;
  }

  printsToStdio(): boolean {
    return false;
  }

  onTestBegin(_test: TestCase, result: TestResult): void {
    this.stderrByWorker.delete(result.workerIndex);
  }

  onStdErr(chunk: string | Buffer, _test: void | TestCase, result: void | TestResult): void {
    if (!result) return;
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const buf = this.stderrByWorker.get(result.workerIndex) ?? [];
    buf.push(text);
    this.stderrByWorker.set(result.workerIndex, buf);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const traceCtx = this.resolveTraceContext(test);
    if (!traceCtx) return;
    if (!fs.existsSync(traceCtx.ndjsonPath)) return;
    if (this.inspector.endsWithTestResult(traceCtx.ndjsonPath)) return;

    const stderr = (this.stderrByWorker.get(result.workerIndex) ?? []).join('');
    const error = this.classifier.classify(result.errors, stderr);
    const record = this.buildSyntheticTestResult(result, stderr, error);

    try {
      this.appendFile(traceCtx.ndjsonPath, JSON.stringify(record) + '\n');
    } catch (err) {
      // Never crash the Playwright run because of a rescue write.
      // Surface the failure on stderr so it shows up in CI logs;
      // the original test failure is what the user cares about.
      process.stderr.write(
        `[heal-playwright-tracer/reporter] failed to append synthetic test-result to ${traceCtx.ndjsonPath}: ${String(err)}\n`,
      );
      return;
    }

    this.invokeRescueHook(record, traceCtx, test, result);
  }

  private resolveTraceContext(test: TestCase): HealTraceContext | null {
    const annotation = test.annotations.find((a) => a.type === HEAL_TRACE_CONTEXT_ANNOTATION);
    const description = annotation?.description;
    if (typeof description !== 'string' || description.length === 0) return null;
    try {
      const parsed = JSON.parse(description) as Partial<HealTraceContext>;
      if (typeof parsed.ndjsonPath !== 'string' || parsed.ndjsonPath.length === 0) return null;
      if (typeof parsed.rootDir !== 'string' || parsed.rootDir.length === 0) return null;
      return { ndjsonPath: parsed.ndjsonPath, rootDir: parsed.rootDir };
    } catch {
      return null;
    }
  }

  private buildSyntheticTestResult(
    result: TestResult,
    stderr: string,
    error: StatementError,
  ): TestResultRecord {
    const record: TestResultRecord = {
      kind: 'test-result',
      status: result.status,
      duration: result.duration,
      error,
    };
    if (stderr.length > 0) record.stderr = [stderr];
    return record;
  }

  private invokeRescueHook(
    record: TestResultRecord,
    traceCtx: HealTraceContext,
    test: TestCase,
    result: TestResult,
  ): void {
    if (!this.onRescue) return;
    const rescueCtx: RescueContext = {
      ndjsonPath: traceCtx.ndjsonPath,
      rootDir: traceCtx.rootDir,
      testId: test.id,
      attempt: result.retry + 1,
      workerIndex: result.workerIndex,
    };
    // Fire-and-forget: Playwright's `onTestEnd` is typed as sync
    // `void`, and the synthetic record is already durably on disk.
    // A slow or failing hook must not block the reporter or
    // propagate errors to the Playwright run.
    void Promise.resolve()
      .then(() => this.onRescue!(record, rescueCtx))
      .catch((err: unknown) => {
        process.stderr.write(
          `[heal-playwright-tracer/reporter] onRescue hook failed: ${String(err)}\n`,
        );
      });
  }
}
