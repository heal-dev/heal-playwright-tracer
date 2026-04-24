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
//   1. Resolves the per-test NDJSON path from an annotation the
//      fixture registers at test start (`HEAL_NDJSON_ANNOTATION`).
//      Using an annotation (not a computed path) means this reporter
//      never has to duplicate `HealDataLayout`'s path logic and
//      stays correct under any user `outputDir` config.
//   2. Early-returns if the NDJSON is missing (tracer not wired
//      for this test) or already ends with `test-result` (fixture
//      finalized cleanly — normal case).
//   3. Classifies the crash via `CrashErrorClassifier` using the
//      worker's stderr buffer and `TestResult.errors`, then appends
//      a synthetic `test-result` line with the classified error.
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
 * reporter knows which NDJSON file belongs to which test. Matches
 * the string constant used in
 * `src/application/playwright-fixture/index.ts`.
 */
export const HEAL_NDJSON_ANNOTATION = 'heal-ndjson-path';

export interface HealTracerReporterDeps {
  classifier?: CrashErrorClassifier;
  inspector?: NdjsonTailInspector;
  /**
   * Seam for tests — defaults to `fs.appendFileSync`. Kept sync so
   * the synthetic line hits disk before the reporter returns, same
   * crash-safety discipline as `NdjsonExporter`.
   */
  appendFile?: (path: string, data: string) => void;
}

export class HealTracerReporter implements Reporter {
  private readonly classifier: CrashErrorClassifier;
  private readonly inspector: NdjsonTailInspector;
  private readonly appendFile: (path: string, data: string) => void;
  private readonly stderrByWorker = new Map<number, string[]>();

  constructor(deps: HealTracerReporterDeps = {}) {
    this.classifier = deps.classifier ?? new CrashErrorClassifier();
    this.inspector = deps.inspector ?? new NdjsonTailInspector();
    this.appendFile = deps.appendFile ?? ((p, d) => fs.appendFileSync(p, d, { encoding: 'utf8' }));
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
    const ndjsonPath = this.resolveNdjsonPath(test);
    if (!ndjsonPath) return;
    if (!fs.existsSync(ndjsonPath)) return;
    if (this.inspector.endsWithTestResult(ndjsonPath)) return;

    const stderr = (this.stderrByWorker.get(result.workerIndex) ?? []).join('');
    const error = this.classifier.classify(result.errors, stderr);
    const record = this.buildSyntheticTestResult(result, stderr, error);

    try {
      this.appendFile(ndjsonPath, JSON.stringify(record) + '\n');
    } catch (err) {
      // Never crash the Playwright run because of a rescue write.
      // Surface the failure on stderr so it shows up in CI logs;
      // the original test failure is what the user cares about.
      process.stderr.write(
        `[heal-playwright-tracer/reporter] failed to append synthetic test-result to ${ndjsonPath}: ${String(err)}\n`,
      );
    }
  }

  private resolveNdjsonPath(test: TestCase): string | null {
    const annotation = test.annotations.find((a) => a.type === HEAL_NDJSON_ANNOTATION);
    const described = annotation?.description;
    return typeof described === 'string' && described.length > 0 ? described : null;
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
}
