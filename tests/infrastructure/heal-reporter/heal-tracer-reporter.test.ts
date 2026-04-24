/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TestCase, TestResult } from '@playwright/test/reporter';
import {
  HealTracerReporter,
  HEAL_NDJSON_ANNOTATION,
} from '../../../src/infrastructure/heal-reporter';
import type { TestResultRecord } from '../../../src/domain/trace-event-recorder/model/statement-trace-schema';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-reporter-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeNdjson(filename: string, content: string): string {
  const p = path.join(tmpDir, filename);
  fs.writeFileSync(p, content);
  return p;
}

function fakeTestCase(ndjsonPath: string | null): TestCase {
  const annotations = ndjsonPath ? [{ type: HEAL_NDJSON_ANNOTATION, description: ndjsonPath }] : [];
  return { annotations } as unknown as TestCase;
}

function fakeResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    workerIndex: 0,
    status: 'failed',
    duration: 12345,
    errors: [],
    stdout: [],
    stderr: [],
    ...overrides,
  } as unknown as TestResult;
}

function readLines(filePath: string): string[] {
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);
}

describe('HealTracerReporter — no-op paths', () => {
  it('does nothing when the NDJSON already ends with a test-result', () => {
    const p = writeNdjson(
      'clean.ndjson',
      '{"kind":"test-header","schemaVersion":1}\n' +
        '{"kind":"test-result","status":"passed","duration":10}\n',
    );
    const before = fs.readFileSync(p);
    const reporter = new HealTracerReporter();
    reporter.onTestEnd(fakeTestCase(p), fakeResult({ status: 'passed', duration: 10 }));
    expect(fs.readFileSync(p)).toEqual(before);
  });

  it('does nothing when the NDJSON file does not exist', () => {
    const missing = path.join(tmpDir, 'missing.ndjson');
    const reporter = new HealTracerReporter();
    reporter.onTestEnd(fakeTestCase(missing), fakeResult());
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('does nothing when the annotation is absent', () => {
    const reporter = new HealTracerReporter();
    reporter.onTestEnd(fakeTestCase(null), fakeResult());
    // No throw, no files created in tmpDir.
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });
});

describe('HealTracerReporter — crash rescue', () => {
  it('appends a synthetic OutOfMemoryError test-result when stderr carries the banner', () => {
    const p = writeNdjson(
      'oom.ndjson',
      '{"kind":"test-header","schemaVersion":1}\n' +
        '{"kind":"statement","statement":{"seq":1,"line":32,"source":"await x"}}\n',
    );
    const reporter = new HealTracerReporter();
    reporter.onStdErr(
      'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n',
      undefined,
      fakeResult({ workerIndex: 2 }),
    );
    reporter.onTestEnd(
      fakeTestCase(p),
      fakeResult({ workerIndex: 2, status: 'failed', duration: 4000 }),
    );

    const lines = readLines(p);
    const last = JSON.parse(lines[lines.length - 1]) as TestResultRecord;
    expect(last.kind).toBe('test-result');
    expect(last.status).toBe('failed');
    expect(last.duration).toBe(4000);
    expect(last.error?.name).toBe('OutOfMemoryError');
    expect(last.error?.message).toContain('heap out of memory');
    expect(last.stderr?.[0]).toContain('heap out of memory');
  });

  it('appends a WorkerCrash test-result when errors[] has a "Worker process exited" message', () => {
    const p = writeNdjson('crash.ndjson', '{"kind":"test-header","schemaVersion":1}\n');
    const reporter = new HealTracerReporter();
    reporter.onTestEnd(
      fakeTestCase(p),
      fakeResult({
        status: 'failed',
        duration: 2000,
        errors: [{ message: 'Worker process exited unexpectedly (code=null signal=SIGKILL)' }],
      }),
    );

    const lines = readLines(p);
    const last = JSON.parse(lines[lines.length - 1]) as TestResultRecord;
    expect(last.error?.name).toBe('WorkerCrash');
    expect(last.error?.message).toContain('SIGKILL');
  });

  it('keeps per-worker stderr buffers isolated across concurrent tests', () => {
    const pA = writeNdjson('a.ndjson', '{"kind":"test-header","schemaVersion":1}\n');
    const pB = writeNdjson('b.ndjson', '{"kind":"test-header","schemaVersion":1}\n');
    const reporter = new HealTracerReporter();

    reporter.onStdErr(
      'FATAL ERROR: JavaScript heap out of memory\n',
      undefined,
      fakeResult({ workerIndex: 0 }),
    );
    reporter.onStdErr(
      'harmless debug log from worker 1\n',
      undefined,
      fakeResult({ workerIndex: 1 }),
    );

    reporter.onTestEnd(fakeTestCase(pA), fakeResult({ workerIndex: 0, duration: 100 }));
    reporter.onTestEnd(
      fakeTestCase(pB),
      fakeResult({
        workerIndex: 1,
        duration: 200,
        errors: [{ message: 'Worker process exited unexpectedly (code=1 signal=null)' }],
      }),
    );

    const lastA = JSON.parse(readLines(pA).at(-1)!) as TestResultRecord;
    const lastB = JSON.parse(readLines(pB).at(-1)!) as TestResultRecord;
    expect(lastA.error?.name).toBe('OutOfMemoryError');
    expect(lastB.error?.name).toBe('WorkerCrash');
    // Worker 1's stderr did NOT leak into worker 0's rescue, and vice versa.
    expect(lastA.stderr?.join('') ?? '').not.toContain('harmless debug log');
    expect(lastB.stderr?.join('') ?? '').not.toContain('heap out of memory');
  });

  it('clears the per-worker stderr buffer on onTestBegin so a fresh test does not inherit previous stderr', () => {
    const p1 = writeNdjson('t1.ndjson', '{"kind":"test-header","schemaVersion":1}\n');
    const p2 = writeNdjson('t2.ndjson', '{"kind":"test-header","schemaVersion":1}\n');
    const reporter = new HealTracerReporter();

    // First test on worker 0 crashes with OOM.
    reporter.onStdErr(
      'FATAL ERROR: JavaScript heap out of memory\n',
      undefined,
      fakeResult({ workerIndex: 0 }),
    );
    reporter.onTestEnd(fakeTestCase(p1), fakeResult({ workerIndex: 0, duration: 100 }));

    // Second test begins on the SAME worker — no new stderr, no crash,
    // just a Playwright-reported failure.
    reporter.onTestBegin(fakeTestCase(p2), fakeResult({ workerIndex: 0 }));
    reporter.onTestEnd(
      fakeTestCase(p2),
      fakeResult({
        workerIndex: 0,
        duration: 200,
        status: 'failed',
        errors: [{ message: 'Worker process exited unexpectedly (code=1 signal=null)' }],
      }),
    );

    const last2 = JSON.parse(readLines(p2).at(-1)!) as TestResultRecord;
    expect(last2.error?.name).toBe('WorkerCrash');
    expect(last2.stderr).toBeUndefined();
  });

  it('swallows append errors and logs to process.stderr', () => {
    const p = writeNdjson('append-fail.ndjson', '{"kind":"test-header","schemaVersion":1}\n');
    const captured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;

    try {
      const reporter = new HealTracerReporter({
        appendFile: () => {
          throw new Error('disk full');
        },
      });
      reporter.onTestEnd(fakeTestCase(p), fakeResult({ duration: 1 }));
    } finally {
      process.stderr.write = origWrite;
    }

    expect(captured.join('')).toContain('failed to append synthetic test-result');
    expect(captured.join('')).toContain('disk full');
  });
});
