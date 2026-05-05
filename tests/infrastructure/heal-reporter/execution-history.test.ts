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
      attempt: 1,
      status: 'passed',
    });
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
