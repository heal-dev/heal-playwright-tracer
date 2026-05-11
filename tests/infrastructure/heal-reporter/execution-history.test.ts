/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { FullConfig, TestCase, TestResult } from '@playwright/test/reporter';

import { HealTracerReporter } from '../../../src/infrastructure/heal-reporter';
import { resetExecutionIdForTesting } from '../../../src/infrastructure/heal-traces-layout';
import type { ExecutionManifest, ExecutionRecord } from '../../../src/domain/persistence';

let tmpDir: string;
let projectOutputDir: string;
let originalCwd: string;
let originalExecEnv: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-reporter-history-'));
  projectOutputDir = path.join(tmpDir, 'test-results');
  fs.mkdirSync(projectOutputDir, { recursive: true });
  originalCwd = process.cwd();
  process.chdir(tmpDir);
  originalExecEnv = process.env.HEAL_EXECUTION_ID;
  delete process.env.HEAL_EXECUTION_ID;
  resetExecutionIdForTesting();
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalExecEnv === undefined) {
    delete process.env.HEAL_EXECUTION_ID;
  } else {
    process.env.HEAL_EXECUTION_ID = originalExecEnv;
  }
  resetExecutionIdForTesting();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fakeConfig(): FullConfig {
  return {
    projects: [{ outputDir: projectOutputDir }],
  } as unknown as FullConfig;
}

function fakeTestCase(opts: { id?: string; title?: string } = {}): TestCase {
  return {
    id: opts.id ?? 'tid-abc',
    title: opts.title ?? 't',
    titlePath: () => ['', 'suite', opts.title ?? 't'],
    location: { file: '/repo/x.spec.ts' },
    parent: { project: () => ({ name: 'chromium' }) },
  } as unknown as TestCase;
}

function fakeResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    workerIndex: 0,
    status: 'passed',
    duration: 100,
    retry: 0,
    errors: [],
    stdout: [],
    stderr: [],
    startTime: new Date('2026-05-05T14:20:31Z'),
    ...overrides,
  } as unknown as TestResult;
}

interface NdjsonSetup {
  executionId: string;
  testId: string;
  attempt: number;
  /** Raw heal-traces.ndjson lines to write (already JSON-stringifyable). */
  lines: unknown[];
}

/**
 * Stages a heal-traces.ndjson under heal-traces/<exec>/<tid>/<attempt>/
 * and the matching .heal-pending registry entry so onTestEnd resolves
 * the trace context. Returns the ndjson path for later assertions.
 */
function stageNdjson(s: NdjsonSetup): string {
  const dir = path.join(tmpDir, 'heal-traces', s.executionId, s.testId, String(s.attempt));
  fs.mkdirSync(dir, { recursive: true });
  const ndjsonPath = path.join(dir, 'heal-traces.ndjson');
  fs.writeFileSync(ndjsonPath, s.lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

  const pendingDir = path.join(projectOutputDir, '.heal-pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.writeFileSync(
    path.join(pendingDir, `${s.testId}-${s.attempt}.json`),
    JSON.stringify({
      ndjsonPath,
      rootDir: dir,
      playwrightOutputDir: projectOutputDir,
      executionId: s.executionId,
    }),
    'utf8',
  );

  return ndjsonPath;
}

describe('HealTracerReporter — executionId propagation', () => {
  it('on a generated executionId, sets HEAL_EXECUTION_ID so workers inherit', async () => {
    delete process.env.HEAL_EXECUTION_ID;
    const reporter = new HealTracerReporter();
    reporter.onBegin?.(fakeConfig(), {} as never);
    expect(process.env.HEAL_EXECUTION_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('preserves an externally-set HEAL_EXECUTION_ID', async () => {
    process.env.HEAL_EXECUTION_ID = 'ci-shard-7';
    const reporter = new HealTracerReporter();
    reporter.onBegin?.(fakeConfig(), {} as never);
    expect(process.env.HEAL_EXECUTION_ID).toBe('ci-shard-7');
  });
});

describe('HealTracerReporter — onEnd manifest + executions.ndjson', () => {
  it('writes execution.json under heal-traces/<executionId>/ with the per-test entries', async () => {
    process.env.HEAL_EXECUTION_ID = 'exec-fixed';
    const reporter = new HealTracerReporter();
    reporter.onBegin?.(fakeConfig(), {} as never);

    reporter.onTestEnd?.(fakeTestCase({ id: 'tid-1', title: 'first' }), fakeResult());
    reporter.onTestEnd?.(
      fakeTestCase({ id: 'tid-2', title: 'second' }),
      fakeResult({ status: 'failed', duration: 200 }),
    );

    reporter.onEnd?.();

    const manifestPath = path.join(tmpDir, 'heal-traces', 'exec-fixed', 'execution.json');
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ExecutionManifest;
    expect(manifest.executionId).toBe('exec-fixed');
    expect(manifest.source).toBe('env');
    expect(manifest.totals).toMatchObject({
      tests: 2,
      passed: 1,
      failed: 1,
    });
    expect(manifest.tests).toHaveLength(2);
    expect(manifest.tests[0]).toMatchObject({
      playwrightTestId: 'tid-1',
      title: 'first',
      project: 'chromium',
      file: '/repo/x.spec.ts',
    });
    expect(manifest.tests[0].attempts).toHaveLength(1);
    expect(manifest.tests[0].attempts[0]).toMatchObject({
      attempt: 1,
      status: 'passed',
    });
    expect(manifest.tests[0].attempts[0].failingStatement).toBeUndefined();
    expect(manifest.tests[0].attempts[0].error).toBeUndefined();
  });

  it('groups retry attempts of the same test under a single entry', async () => {
    process.env.HEAL_EXECUTION_ID = 'exec-retry';
    const reporter = new HealTracerReporter();
    reporter.onBegin?.(fakeConfig(), {} as never);

    const test = fakeTestCase({ id: 'tid-flaky', title: 'flaky' });
    reporter.onTestEnd?.(test, fakeResult({ status: 'failed', retry: 0 }));
    reporter.onTestEnd?.(test, fakeResult({ status: 'passed', retry: 1 }));

    reporter.onEnd?.();

    const manifestPath = path.join(tmpDir, 'heal-traces', 'exec-retry', 'execution.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ExecutionManifest;
    expect(manifest.tests).toHaveLength(1);
    expect(manifest.tests[0].playwrightTestId).toBe('tid-flaky');
    expect(
      manifest.tests[0].attempts.map((a) => ({ attempt: a.attempt, status: a.status })),
    ).toEqual([
      { attempt: 1, status: 'failed' },
      { attempt: 2, status: 'passed' },
    ]);
    // Per-attempt totals: each retry counts toward `tests`.
    expect(manifest.totals).toMatchObject({ tests: 2, passed: 1, failed: 1 });
  });

  it('populates failingStatement + error from the deepest threw leaf in heal-traces.ndjson', async () => {
    process.env.HEAL_EXECUTION_ID = 'exec-failing';
    const reporter = new HealTracerReporter();
    reporter.onBegin?.(fakeConfig(), {} as never);

    const stmt = (over: Record<string, unknown>) => ({
      seq: 1,
      index: 0,
      file: 'x.spec.ts',
      line: 4,
      endLine: 4,
      kind: 'CallExpression',
      scope: 'root',
      source: 'noop()',
      hasAwait: false,
      step: null,
      stepPath: null,
      status: 'ok',
      duration: 1,
      t: 0,
      children: [],
      ...over,
    });
    stageNdjson({
      executionId: 'exec-failing',
      testId: 'tid-fail',
      attempt: 1,
      lines: [
        { kind: 'test-header', test: { executionId: 'exec-failing' } },
        {
          kind: 'statement',
          statement: stmt({
            status: 'threw',
            source: 'await page.locator("#go").click()',
            error: { message: 'outer' },
            children: [
              stmt({
                index: 1,
                status: 'threw',
                source: 'page.locator("#go").click()',
                error: { message: 'locator timeout', isPlaywrightError: true },
              }),
            ],
          }),
        },
        { kind: 'test-result', status: 'failed', duration: 5 },
      ],
    });

    reporter.onTestEnd?.(
      fakeTestCase({ id: 'tid-fail', title: 'fails on click' }),
      fakeResult({ status: 'failed', retry: 0 }),
    );
    reporter.onEnd?.();

    const manifestPath = path.join(tmpDir, 'heal-traces', 'exec-failing', 'execution.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ExecutionManifest;
    const attempt = manifest.tests[0].attempts[0];
    expect(attempt.failingStatement).toMatchObject({
      index: 1,
      file: 'x.spec.ts',
      line: 4,
      source: 'page.locator("#go").click()',
    });
    expect(attempt.error).toMatchObject({
      message: 'locator timeout',
      isPlaywrightError: true,
    });
  });

  it('on a failed test with no registry entry, captures the attempt without failingStatement/error', () => {
    process.env.HEAL_EXECUTION_ID = 'exec-noreg';
    const reporter = new HealTracerReporter();
    reporter.onBegin?.(fakeConfig(), {} as never);

    reporter.onTestEnd?.(fakeTestCase({ id: 'tid-x' }), fakeResult({ status: 'failed' }));
    reporter.onEnd?.();

    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'heal-traces', 'exec-noreg', 'execution.json'), 'utf8'),
    ) as ExecutionManifest;
    const attempt = manifest.tests[0].attempts[0];
    expect(attempt.status).toBe('failed');
    expect(attempt.failingStatement).toBeUndefined();
    expect(attempt.error).toBeUndefined();
  });

  it('does not invoke the finder on skipped attempts', () => {
    process.env.HEAL_EXECUTION_ID = 'exec-skip';
    const reporter = new HealTracerReporter();
    reporter.onBegin?.(fakeConfig(), {} as never);

    // Stage an NDJSON that DOES contain a threw statement — but
    // because the attempt's status is `skipped`, the reporter must
    // not look at it.
    stageNdjson({
      executionId: 'exec-skip',
      testId: 'tid-skip',
      attempt: 1,
      lines: [
        { kind: 'test-header', test: { executionId: 'exec-skip' } },
        {
          kind: 'statement',
          statement: {
            seq: 1,
            index: 0,
            file: 'x.spec.ts',
            line: 1,
            endLine: 1,
            kind: 'CallExpression',
            scope: 'root',
            source: 'boom()',
            hasAwait: false,
            step: null,
            stepPath: null,
            status: 'threw',
            duration: 1,
            t: 0,
            error: { message: 'should-not-surface' },
            children: [],
          },
        },
        { kind: 'test-result', status: 'skipped', duration: 0 },
      ],
    });

    reporter.onTestEnd?.(fakeTestCase({ id: 'tid-skip' }), fakeResult({ status: 'skipped' }));
    reporter.onEnd?.();

    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'heal-traces', 'exec-skip', 'execution.json'), 'utf8'),
    ) as ExecutionManifest;
    const attempt = manifest.tests[0].attempts[0];
    expect(attempt.status).toBe('skipped');
    expect(attempt.failingStatement).toBeUndefined();
    expect(attempt.error).toBeUndefined();
  });

  it('on a crash rescue with no threw statement, falls back to the rescued record error', () => {
    process.env.HEAL_EXECUTION_ID = 'exec-crash';
    const reporter = new HealTracerReporter();
    reporter.onBegin?.(fakeConfig(), {} as never);

    // NDJSON has only a header — no statements, no test-result.
    // The reporter must synthesize a test-result (rescue path) and
    // the finder must then return null, so the attempt error comes
    // from the synthetic record.
    stageNdjson({
      executionId: 'exec-crash',
      testId: 'tid-crash',
      attempt: 1,
      lines: [{ kind: 'test-header', test: { executionId: 'exec-crash' } }],
    });

    reporter.onTestEnd?.(
      fakeTestCase({ id: 'tid-crash' }),
      fakeResult({
        status: 'failed',
        errors: [{ message: 'Worker process exited with code 137' }],
      } as Partial<TestResult>),
    );
    reporter.onEnd?.();

    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'heal-traces', 'exec-crash', 'execution.json'), 'utf8'),
    ) as ExecutionManifest;
    const attempt = manifest.tests[0].attempts[0];
    expect(attempt.failingStatement).toBeUndefined();
    expect(attempt.error).toBeDefined();
    expect(attempt.error?.message).toMatch(/worker/i);
  });

  it('on a crash rescue with a pre-crash threw statement, prefers the statement-level error over the rescued one', () => {
    process.env.HEAL_EXECUTION_ID = 'exec-crash-pre';
    const reporter = new HealTracerReporter();
    reporter.onBegin?.(fakeConfig(), {} as never);

    // NDJSON contains a threw statement BEFORE the worker died —
    // no test-result terminator. The reporter rescues, then the
    // finder picks up the real failure leaf; that wins over the
    // synthesized rescue error.
    stageNdjson({
      executionId: 'exec-crash-pre',
      testId: 'tid-precrash',
      attempt: 1,
      lines: [
        { kind: 'test-header', test: { executionId: 'exec-crash-pre' } },
        {
          kind: 'statement',
          statement: {
            seq: 1,
            index: 4,
            file: 'x.spec.ts',
            line: 7,
            endLine: 7,
            kind: 'CallExpression',
            scope: 'root',
            source: 'page.evaluate(blow_up)',
            hasAwait: true,
            step: null,
            stepPath: null,
            status: 'threw',
            duration: 1,
            t: 0,
            error: { message: 'real user error' },
            children: [],
          },
        },
      ],
    });

    reporter.onTestEnd?.(
      fakeTestCase({ id: 'tid-precrash' }),
      fakeResult({
        status: 'failed',
        errors: [{ message: 'Worker process exited with code 137' }],
      } as Partial<TestResult>),
    );
    reporter.onEnd?.();

    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'heal-traces', 'exec-crash-pre', 'execution.json'), 'utf8'),
    ) as ExecutionManifest;
    const attempt = manifest.tests[0].attempts[0];
    expect(attempt.failingStatement?.index).toBe(4);
    expect(attempt.error?.message).toBe('real user error');
  });

  it('appends one ExecutionRecord line per run to executions.ndjson', async () => {
    process.env.HEAL_EXECUTION_ID = 'exec-appender';
    const reporter = new HealTracerReporter();
    reporter.onBegin?.(fakeConfig(), {} as never);
    reporter.onTestEnd?.(fakeTestCase(), fakeResult());
    reporter.onEnd?.();

    const ndjsonPath = path.join(tmpDir, 'heal-traces', 'executions.ndjson');
    expect(fs.existsSync(ndjsonPath)).toBe(true);
    const lines = fs
      .readFileSync(ndjsonPath, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]) as ExecutionRecord;
    expect(rec.kind).toBe('execution');
    expect(rec.executionId).toBe('exec-appender');
    expect(rec.source).toBe('env');
    expect(rec.totals.tests).toBe(1);
    expect(typeof rec.startedAt).toBe('number');
    expect(typeof rec.endedAt).toBe('number');
    expect(rec.endedAt).toBeGreaterThanOrEqual(rec.startedAt);
  });

  it('appends across consecutive runs without overwriting previous lines', async () => {
    // Run 1
    process.env.HEAL_EXECUTION_ID = 'exec-1';
    let reporter = new HealTracerReporter();
    reporter.onBegin?.(fakeConfig(), {} as never);
    reporter.onTestEnd?.(fakeTestCase(), fakeResult());
    reporter.onEnd?.();

    // Run 2 — fresh reporter, fresh memoized id
    resetExecutionIdForTesting();
    process.env.HEAL_EXECUTION_ID = 'exec-2';
    reporter = new HealTracerReporter();
    reporter.onBegin?.(fakeConfig(), {} as never);
    reporter.onTestEnd?.(fakeTestCase(), fakeResult({ status: 'failed' }));
    reporter.onEnd?.();

    const lines = fs
      .readFileSync(path.join(tmpDir, 'heal-traces', 'executions.ndjson'), 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const ids = lines.map((l) => (JSON.parse(l) as ExecutionRecord).executionId);
    expect(ids).toEqual(['exec-1', 'exec-2']);
  });

  it('records source="generated" when HEAL_EXECUTION_ID was unset at onBegin', async () => {
    delete process.env.HEAL_EXECUTION_ID;
    const reporter = new HealTracerReporter();
    reporter.onBegin?.(fakeConfig(), {} as never);
    reporter.onEnd?.();

    const ndjsonPath = path.join(tmpDir, 'heal-traces', 'executions.ndjson');
    const line = fs
      .readFileSync(ndjsonPath, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)[0];
    const rec = JSON.parse(line) as ExecutionRecord;
    expect(rec.source).toBe('generated');
  });
});
