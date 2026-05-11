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
// The reporter subscribes to `onTestEnd` — which fires even when
// the worker died, because Playwright fabricates the result from
// the main-process side. It then:
//
//   1. Resolves the per-test NDJSON path + outputDir from a
//      filesystem REGISTRY the fixture writes at test setup:
//      `<project.outputDir>/.heal-pending/<testId>-<attempt>.json`.
//      The registry is needed because Playwright's IPC does NOT
//      flush fixture-pushed annotations/attachments on abrupt
//      worker exit (OOM/SIGKILL/`process.exit()`) — exactly the
//      cases we most need to rescue. A file on disk survives any
//      abrupt exit. The fixture deletes the registry entry at
//      teardown, so only crashed tests leave an orphan behind.
//      This reporter is then the only thing that reads the orphan.
//   2. Early-returns if the registry entry is missing (tracer not
//      wired for this test, or fixture already deleted it on clean
//      teardown) or if the NDJSON already ends with `test-result`
//      (defensive — shouldn't happen given the deletion step).
//   3. Classifies the crash via `CrashErrorClassifier` using the
//      worker's stderr buffer and `TestResult.errors`, then appends
//      a synthetic `test-result` line with the classified error.
//   4. If an `onRescue` hook is configured, invokes it (fire-and-
//      forget) so extension code can observe the rescued record.
//
// Registration (user-facing, in `playwright.config.ts`):
//
//   reporter: [['@heal-dev/heal-playwright-tracer/reporter']]
//
// Registration is mandatory whenever the Babel plugin is wired —
// the fixture asserts on the `HEAL_TRACER_REPORTER` env var (set
// here in `onBegin`) and fails fast if it's missing.

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { FullConfig, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import type {
  StatementError,
  TestAttachment,
  TestAttachmentsRecord,
  TestResultRecord,
} from '../../domain/trace-event-recorder/model/statement-trace-schema';
import {
  EXECUTION_RECORD_KIND,
  type AttemptEntry,
  type ExecutionManifest,
  type ExecutionRecord,
  type ExecutionTestEntry,
  type ExecutionTotals,
  type TestStatus,
} from '../../domain/persistence';
import { HealTracesLayout, getExecutionIdSource, resolveExecutionId } from '../heal-traces-layout';
import { CrashErrorClassifier } from './crash-error-classifier';
import { FailingStatementFinder } from './failing-statement-finder';
import { NdjsonTailInspector } from './ndjson-tail-inspector';
import { log } from '../../util/logger';

/**
 * Subdirectory under each project's `outputDir` where the fixture
 * writes a registry entry per (testId, attempt). Shared string
 * constant between fixture (writer) and reporter (reader).
 */
export const HEAL_PENDING_SUBDIR = '.heal-pending';

/**
 * Shape of the per-test registry entry. Minimal: everything else
 * the reporter needs is reachable from `TestCase` / `TestResult`.
 */
export interface HealTraceContext {
  /** Absolute path to the per-test `heal-traces.ndjson`. */
  ndjsonPath: string;
  /**
   * Absolute path to the per-(test, attempt) directory inside the
   * persistent `heal-traces/` tree — the destination root the reporter
   * copies Playwright artefacts into. Reporter-emitted
   * `test-attachments` paths are relative to this directory.
   */
  rootDir: string;
  /**
   * Absolute `testInfo.outputDir` — the source directory Playwright
   * writes its own attachments into (`trace.zip`, `video.webm`,
   * failure screenshots, user `testInfo.attach()` files).
   */
  playwrightOutputDir: string;
  /** Per-process executionId at the time the fixture wrote the entry. */
  executionId: string;
}

/**
 * Context handed to the `onRescue` hook. Extends `HealTraceContext`
 * with the per-test correlation fields the hook needs to route the
 * synthetic record.
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
 * exporters never got to reach — anything running per-test inside
 * the worker dies with it on a crash.
 *
 * Errors are caught by the reporter and logged to `process.stderr`;
 * a failing hook never breaks the Playwright run or prevents the
 * on-disk append from landing.
 */
export type RescueHook = (record: TestResultRecord, ctx: RescueContext) => void | Promise<void>;

export interface HealTracerReporterDeps {
  classifier?: CrashErrorClassifier;
  inspector?: NdjsonTailInspector;
  failingStatementFinder?: FailingStatementFinder;
  /**
   * Seam for tests — defaults to `fs.appendFileSync`. Kept sync so
   * the synthetic line hits disk before the reporter returns, same
   * crash-safety discipline as `NdjsonExporter`.
   */
  appendFile?: (path: string, data: string) => void;
  onRescue?: RescueHook;
}

/** Path to the registry file for a given (project, test, attempt). */
export function healPendingRegistryPath(
  projectOutputDir: string,
  testId: string,
  attempt: number,
): string {
  return path.join(projectOutputDir, HEAL_PENDING_SUBDIR, `${testId}-${attempt}.json`);
}

export class HealTracerReporter implements Reporter {
  private readonly classifier: CrashErrorClassifier;
  private readonly inspector: NdjsonTailInspector;
  private readonly failingStatementFinder: FailingStatementFinder;
  private readonly appendFile: (path: string, data: string) => void;
  private readonly onRescue: RescueHook | null;
  private readonly stderrByWorker = new Map<number, string[]>();
  private projectOutputDirs: string[] = [];

  // Execution history (P2) — reporter is the only writer of
  // executions.ndjson + execution.json. Resolved at onBegin so the
  // executionId propagates to workers via HEAL_EXECUTION_ID.
  private executionId = '';
  private executionSource: 'env' | 'generated' = 'generated';
  private startedAt = 0;
  private rootDir = '';
  private playwrightVersion: string | undefined;
  private gitInfo: ExecutionRecord['git'];
  // Keyed by playwrightTestId so retries fold into the same test entry.
  // Insertion order = first-seen test order, which the manifest preserves.
  private readonly testEntriesById = new Map<string, ExecutionTestEntry>();

  constructor(deps: HealTracerReporterDeps = {}) {
    this.classifier = deps.classifier ?? new CrashErrorClassifier();
    this.inspector = deps.inspector ?? new NdjsonTailInspector();
    this.failingStatementFinder = deps.failingStatementFinder ?? new FailingStatementFinder();
    this.appendFile = deps.appendFile ?? ((p, d) => fs.appendFileSync(p, d, { encoding: 'utf8' }));
    this.onRescue = deps.onRescue ?? null;
  }

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, _suite: unknown): void {
    // Capture every project's outputDir so we know where to look
    // for registry entries regardless of which project a given
    // TestCase belongs to. Deduped — sharded configs sometimes
    // repeat the same outputDir across projects.
    const seen = new Set<string>();
    for (const project of config.projects) {
      if (project.outputDir && !seen.has(project.outputDir)) {
        seen.add(project.outputDir);
        this.projectOutputDirs.push(project.outputDir);
      }
    }

    // Resolve executionId once in main BEFORE workers spawn, then
    // propagate via env so worker fixtures see the same value.
    // Workers' resolver reports `source='env'` after this — that's
    // expected; the truthful source we record on the run is OURS,
    // captured here before we mutate the env var.
    this.executionSource = getExecutionIdSource();
    this.executionId = resolveExecutionId();
    if (this.executionSource === 'generated') {
      process.env.HEAL_EXECUTION_ID = this.executionId;
    }

    // Worker fixtures assert on this env var to detect when a user has
    // wired the Babel plugin but forgotten to register the reporter.
    // Setting it here (before workers spawn) is the handshake; the
    // fixture's check is the enforcement.
    process.env.HEAL_TRACER_REPORTER = '1';

    this.startedAt = Date.now();
    this.rootDir = process.cwd();
    this.playwrightVersion = readPlaywrightVersion();
    this.gitInfo = readGitInfo();
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
    const traceCtx = this.resolveTraceContext(test, result);

    // Tracer not wired for this test (no registry entry) or the
    // worker never started a trace file — record what Playwright
    // already knows and stop. No failing-statement source on disk.
    if (!traceCtx || !fs.existsSync(traceCtx.ndjsonPath)) {
      this.captureAttempt(test, result, null, null);
      if (traceCtx) this.cleanupRegistry(test, result);
      return;
    }

    let rescuedRecord: TestResultRecord | null = null;

    // Rescue path: file is missing the `test-result` terminator.
    // Synthesize one from the worker's stderr buffer + Playwright's
    // post-mortem `result.errors`.
    if (!this.inspector.endsWithTestResult(traceCtx.ndjsonPath)) {
      const stderr = (this.stderrByWorker.get(result.workerIndex) ?? []).join('');
      const error = this.classifier.classify(result.errors, stderr);
      rescuedRecord = this.buildSyntheticTestResult(result, stderr, error);

      try {
        this.appendFile(traceCtx.ndjsonPath, JSON.stringify(rescuedRecord) + '\n');
      } catch (err) {
        log.error(`failed to append synthetic test-result to ${traceCtx.ndjsonPath}`, err);
        this.captureAttempt(test, result, null, null);
        this.cleanupRegistry(test, result);
        return;
      }
    }

    // Always-on: copy each Playwright attachment from its outputDir
    // location into the persistent heal-traces tree, then append a
    // `test-attachments` record whose paths are relative to that
    // tree. Keeps the file shape canonical (test-result then
    // test-attachments) and makes the heal-traces dir the single
    // source of truth — Playwright's `outputDir` can be wiped, the
    // history survives.
    const attachmentsRecord = this.copyAndBuildAttachmentsRecord(result, traceCtx);
    try {
      this.appendFile(traceCtx.ndjsonPath, JSON.stringify(attachmentsRecord) + '\n');
    } catch (err) {
      log.error(`failed to append test-attachments to ${traceCtx.ndjsonPath}`, err);
    }

    this.captureAttempt(test, result, traceCtx.ndjsonPath, rescuedRecord);
    this.cleanupRegistry(test, result);

    if (rescuedRecord) {
      this.invokeRescueHook(rescuedRecord, traceCtx, test, result);
    }
  }

  // Probes each known project outputDir for the per-test registry
  // entry. First match wins — the same (testId, attempt) never
  // spans projects. Returns null when no entry exists, which means
  // either the tracer wasn't wired for this test or the fixture
  // already cleaned up on a clean teardown.
  private resolveTraceContext(test: TestCase, result: TestResult): HealTraceContext | null {
    const attempt = result.retry + 1;
    for (const outputDir of this.projectOutputDirs) {
      const entryPath = healPendingRegistryPath(outputDir, test.id, attempt);
      let body: string;
      try {
        body = fs.readFileSync(entryPath, 'utf8');
      } catch {
        continue;
      }
      try {
        const parsed = JSON.parse(body) as Partial<HealTraceContext>;
        if (typeof parsed.ndjsonPath !== 'string' || parsed.ndjsonPath.length === 0) continue;
        if (typeof parsed.rootDir !== 'string' || parsed.rootDir.length === 0) continue;
        if (
          typeof parsed.playwrightOutputDir !== 'string' ||
          parsed.playwrightOutputDir.length === 0
        ) {
          continue;
        }
        if (typeof parsed.executionId !== 'string' || parsed.executionId.length === 0) {
          continue;
        }
        return {
          ndjsonPath: parsed.ndjsonPath,
          rootDir: parsed.rootDir,
          playwrightOutputDir: parsed.playwrightOutputDir,
          executionId: parsed.executionId,
        };
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * Copy each Playwright attachment from its `outputDir` location
   * into the persistent heal-traces tree (under `traceCtx.rootDir`),
   * mapping by `name` / `contentType`:
   *
   *   - 'trace'                     → <rootDir>/trace.zip
   *   - contentType: 'video/...'    → <rootDir>/videos/<basename>
   *   - other (screenshot, user)    → <rootDir>/<rel-from-outputDir>
   *
   * Returns a `test-attachments` record whose `path` fields are the
   * destination-relative locations using forward slashes, so the
   * local-viewer-server can serve them via `/api/asset/...`.
   *
   * Attachments whose source path falls outside Playwright's
   * outputDir are dropped — those would not be safely servable.
   */
  private copyAndBuildAttachmentsRecord(
    result: TestResult,
    traceCtx: HealTraceContext,
  ): TestAttachmentsRecord {
    const srcRoot = path.resolve(traceCtx.playwrightOutputDir);
    const dstRoot = path.resolve(traceCtx.rootDir);
    const attachments: TestAttachment[] = [];

    for (const att of result.attachments ?? []) {
      if (!att.path) continue;
      const srcResolved = path.resolve(att.path);
      const relFromSrc = path.relative(srcRoot, srcResolved);
      if (relFromSrc.length === 0 || relFromSrc.startsWith('..') || path.isAbsolute(relFromSrc)) {
        continue;
      }

      const dstRel = this.placeAttachment(att.name, att.contentType, relFromSrc);
      const dstAbs = path.resolve(dstRoot, dstRel);

      try {
        fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
        fs.copyFileSync(srcResolved, dstAbs);
      } catch (err) {
        log.error(`failed to copy attachment ${att.name} (${srcResolved} → ${dstAbs})`, err);
        continue;
      }

      // Forward slashes on all platforms — the local viewer maps
      // these into URLs and Windows paths break URL routing.
      const rel = dstRel.split(path.sep).join('/');
      attachments.push({
        name: att.name,
        path: rel,
        contentType: att.contentType,
      });
    }

    return { kind: 'test-attachments', attachments };
  }

  private placeAttachment(name: string, contentType: string, relFromSrc: string): string {
    if (name === 'trace') {
      return 'trace.zip';
    }
    if (contentType.toLowerCase().startsWith('video/')) {
      return path.join('videos', path.basename(relFromSrc));
    }

    return relFromSrc;
  }

  private cleanupRegistry(test: TestCase, result: TestResult): void {
    const attempt = result.retry + 1;
    for (const outputDir of this.projectOutputDirs) {
      const entryPath = healPendingRegistryPath(outputDir, test.id, attempt);
      try {
        fs.unlinkSync(entryPath);
      } catch {
        /* entry may not exist; ignore */
      }
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
      playwrightOutputDir: traceCtx.playwrightOutputDir,
      executionId: traceCtx.executionId,
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
        log.error('onRescue hook failed', err);
      });
  }

  /**
   * Upsert the per-test entry for `test` and append an attempt slice
   * built from `result`. When `ndjsonPath` is non-null and the
   * attempt did not pass, scans the file for the deepest threw
   * statement and attaches it as `failingStatement` + `error`. A
   * `rescuedRecord` (synthesized by the rescue path) supplies
   * `error` when no statement-level threw is present.
   */
  private captureAttempt(
    test: TestCase,
    result: TestResult,
    ndjsonPath: string | null,
    rescuedRecord: TestResultRecord | null,
  ): void {
    const entry = this.upsertTestEntry(test);
    const attempt: AttemptEntry = {
      attempt: result.retry + 1,
      status: this.mapTestStatus(result.status),
      startedAt: result.startTime instanceof Date ? result.startTime.getTime() : Date.now(),
      durationMs: result.duration,
    };

    if (attempt.status !== 'passed' && attempt.status !== 'skipped') {
      const found = ndjsonPath ? this.failingStatementFinder.find(ndjsonPath) : null;
      if (found) {
        attempt.failingStatement = found.statement;
        attempt.error = found.error;
      } else if (rescuedRecord?.error) {
        attempt.error = rescuedRecord.error;
      }
    }

    entry.attempts.push(attempt);
  }

  private upsertTestEntry(test: TestCase): ExecutionTestEntry {
    const existing = this.testEntriesById.get(test.id);
    if (existing) return existing;

    const titlePath =
      typeof (test as unknown as { titlePath?: () => string[] }).titlePath === 'function'
        ? (test as unknown as { titlePath: () => string[] }).titlePath()
        : [];
    const file = (test as unknown as { location?: { file?: string } }).location?.file ?? '';
    const project =
      (test as unknown as { parent?: { project?: () => { name?: string } } }).parent?.project?.()
        ?.name ?? '';

    const entry: ExecutionTestEntry = {
      playwrightTestId: test.id,
      title: test.title,
      titlePath,
      file,
      project,
      attempts: [],
    };
    this.testEntriesById.set(test.id, entry);

    return entry;
  }

  private mapTestStatus(s: TestResult['status']): TestStatus {
    switch (s) {
      case 'passed':
      case 'failed':
      case 'timedOut':
      case 'skipped':
      case 'interrupted':
        return s;
      default:
        return 'unknown';
    }
  }

  onEnd(): void {
    if (this.executionId.length === 0) return;

    const layout = new HealTracesLayout(this.rootDir, this.executionId);
    const endedAt = Date.now();
    const tests = Array.from(this.testEntriesById.values());
    const totals = computeTotals(tests);

    const manifest: ExecutionManifest = {
      executionId: this.executionId,
      source: this.executionSource,
      startedAt: this.startedAt,
      endedAt,
      durationMs: endedAt - this.startedAt,
      ...(this.gitInfo ? { git: this.gitInfo } : {}),
      ...(this.playwrightVersion ? { playwrightVersion: this.playwrightVersion } : {}),
      totals,
      tests,
    };

    const record: ExecutionRecord = {
      kind: EXECUTION_RECORD_KIND,
      executionId: this.executionId,
      source: this.executionSource,
      startedAt: this.startedAt,
      endedAt,
      durationMs: endedAt - this.startedAt,
      ...(this.gitInfo ? { git: this.gitInfo } : {}),
      ...(this.playwrightVersion ? { playwrightVersion: this.playwrightVersion } : {}),
      totals,
    };

    try {
      fs.mkdirSync(layout.executionDir(), { recursive: true });
      fs.writeFileSync(layout.executionManifestPath(), JSON.stringify(manifest, null, 2), 'utf8');
    } catch (err) {
      log.error('failed to write execution.json', err);
    }

    try {
      fs.mkdirSync(layout.healTracesRoot(), { recursive: true });
      this.appendFile(layout.executionsNdjsonPath(), JSON.stringify(record) + '\n');
    } catch (err) {
      log.error('failed to append executions.ndjson', err);
    }
  }
}

// Per-attempt totals: each retry counts as a separate row, matching
// the pre-grouping semantics. A flaky test that fails-then-passes
// surfaces as 1 passed + 1 failed against `tests: 2`.
function computeTotals(entries: ExecutionTestEntry[]): ExecutionTotals {
  const totals: ExecutionTotals = {
    tests: 0,
    passed: 0,
    failed: 0,
    timedOut: 0,
    skipped: 0,
    interrupted: 0,
  };
  for (const e of entries) {
    for (const a of e.attempts) {
      totals.tests += 1;
      if (a.status === 'passed') totals.passed += 1;
      else if (a.status === 'failed') totals.failed += 1;
      else if (a.status === 'timedOut') totals.timedOut += 1;
      else if (a.status === 'skipped') totals.skipped += 1;
      else if (a.status === 'interrupted') totals.interrupted += 1;
      // 'unknown' counts toward `tests` but not any per-status bucket.
    }
  }
  return totals;
}

function readPlaywrightVersion(): string | undefined {
  try {
    const pkg = require('@playwright/test/package.json') as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

function readGitInfo(): ExecutionRecord['git'] {
  const sha = tryGit('rev-parse HEAD');
  const branch = tryGit('rev-parse --abbrev-ref HEAD');
  const dirty = tryGit('status --porcelain');
  if (sha === undefined && branch === undefined && dirty === undefined) {
    return undefined;
  }
  const info: NonNullable<ExecutionRecord['git']> = {};
  if (sha !== undefined) info.sha = sha;
  if (branch !== undefined && branch !== 'HEAD') info.branch = branch;
  if (dirty !== undefined) info.dirty = dirty.length > 0;
  return info;
}

function tryGit(args: string): string | undefined {
  try {
    return execSync(`git ${args}`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}
