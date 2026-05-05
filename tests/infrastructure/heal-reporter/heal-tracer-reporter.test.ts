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
import {
  HealTracerReporter,
  HEAL_PENDING_SUBDIR,
  healPendingRegistryPath,
  type RescueContext,
} from '../../../src/infrastructure/heal-reporter';
import type { TestResultRecord } from '../../../src/domain/trace-event-recorder/model/statement-trace-schema';

let tmpDir: string;
let projectOutputDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-reporter-'));
  projectOutputDir = path.join(tmpDir, 'test-results');
  fs.mkdirSync(projectOutputDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Per-test helpers that mirror the fixture's contract: create a
// per-test output dir, write the NDJSON there, register a
// `.heal-pending/<testId>-<attempt>.json` entry pointing at it.
function setupTest(
  opts: {
    testId?: string;
    attempt?: number;
    ndjsonContent?: string | null;
    slug?: string;
  } = {},
): { ndjsonPath: string; rootDir: string; testId: string; attempt: number } {
  const testId = opts.testId ?? 'tid-abc';
  const attempt = opts.attempt ?? 1;
  const slug = opts.slug ?? testId;
  const rootDir = path.join(projectOutputDir, slug);
  const healDataDir = path.join(rootDir, 'heal-data');
  fs.mkdirSync(healDataDir, { recursive: true });
  const ndjsonPath = path.join(healDataDir, 'heal-traces.ndjson');
  if (opts.ndjsonContent !== null) {
    fs.writeFileSync(
      ndjsonPath,
      opts.ndjsonContent ?? '{"kind":"test-header","schemaVersion":1}\n',
    );
  }
  const registryPath = healPendingRegistryPath(projectOutputDir, testId, attempt);
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify({ ndjsonPath, rootDir }));
  return { ndjsonPath, rootDir, testId, attempt };
}

function fakeConfig(): FullConfig {
  return {
    projects: [{ outputDir: projectOutputDir }],
  } as unknown as FullConfig;
}

function fakeTestCase(opts: { id?: string } = {}): TestCase {
  return { id: opts.id ?? 'tid-abc', annotations: [] } as unknown as TestCase;
}

function fakeResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    workerIndex: 0,
    status: 'failed',
    duration: 12345,
    retry: 0,
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

interface ParsedRecord {
  kind: string;
  [key: string]: unknown;
}

/** Find the last record in the NDJSON whose `kind` matches. */
function lastRecordOfKind(lines: string[], kind: string): ParsedRecord {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const parsed = JSON.parse(lines[i]) as ParsedRecord;
    if (parsed.kind === kind) {
      return parsed;
    }
  }
  throw new Error(`No record of kind=${kind} found`);
}

function newReporter(deps: ConstructorParameters<typeof HealTracerReporter>[0] = {}) {
  const reporter = new HealTracerReporter(deps);
  reporter.onBegin?.(fakeConfig(), {} as never);
  return reporter;
}

describe('HealTracerReporter — no-op paths', () => {
  it('appends only the test-attachments record when the NDJSON already ends with a test-result', () => {
    const { ndjsonPath } = setupTest({
      ndjsonContent:
        '{"kind":"test-header","schemaVersion":1}\n' +
        '{"kind":"test-result","status":"passed","duration":10}\n',
    });
    const reporter = newReporter();
    reporter.onTestEnd(fakeTestCase(), fakeResult({ status: 'passed', duration: 10 }));
    const lines = readLines(ndjsonPath);
    // No new test-result was appended — the existing one remains.
    expect(lines.filter((l) => l.includes('"test-result"'))).toHaveLength(1);
    // But test-attachments was appended.
    expect(lines.at(-1)).toContain('"test-attachments"');
  });

  it('does nothing when no registry entry exists for this test', () => {
    // No setupTest(): tmpDir is empty of any pending file.
    const reporter = newReporter();
    reporter.onTestEnd(fakeTestCase(), fakeResult());
    // No synthetic file should have been produced anywhere.
    const pending = path.join(projectOutputDir, HEAL_PENDING_SUBDIR);
    expect(fs.existsSync(pending)).toBe(false);
  });

  it('does nothing when the registry entry is malformed JSON', () => {
    const registryPath = healPendingRegistryPath(projectOutputDir, 'tid-abc', 1);
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, 'not-json{');
    const reporter = newReporter();
    expect(() => reporter.onTestEnd(fakeTestCase(), fakeResult())).not.toThrow();
  });

  it('does nothing when the registry points at a non-existent NDJSON', () => {
    const registryPath = healPendingRegistryPath(projectOutputDir, 'tid-abc', 1);
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(
      registryPath,
      JSON.stringify({ ndjsonPath: '/nowhere/heal-traces.ndjson', rootDir: '/nowhere' }),
    );
    const reporter = newReporter();
    expect(() => reporter.onTestEnd(fakeTestCase(), fakeResult())).not.toThrow();
  });
});

describe('HealTracerReporter — crash rescue', () => {
  it('appends a synthetic OutOfMemoryError test-result when stderr carries the banner', () => {
    const { ndjsonPath } = setupTest();
    const reporter = newReporter();
    reporter.onStdErr(
      'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n',
      undefined,
      fakeResult({ workerIndex: 2 }),
    );
    reporter.onTestEnd(
      fakeTestCase(),
      fakeResult({ workerIndex: 2, status: 'failed', duration: 4000 }),
    );

    const lines = readLines(ndjsonPath);
    const last = lastRecordOfKind(lines, 'test-result') as unknown as TestResultRecord;
    expect(last.kind).toBe('test-result');
    expect(last.status).toBe('failed');
    expect(last.duration).toBe(4000);
    expect(last.error?.name).toBe('OutOfMemoryError');
    expect(last.error?.message).toContain('heap out of memory');
    expect(last.stderr?.[0]).toContain('heap out of memory');
  });

  it('appends a WorkerCrash test-result when errors[] has a "Worker process exited" message', () => {
    const { ndjsonPath } = setupTest();
    const reporter = newReporter();
    reporter.onTestEnd(
      fakeTestCase(),
      fakeResult({
        status: 'failed',
        duration: 2000,
        errors: [{ message: 'Worker process exited unexpectedly (code=null signal=SIGKILL)' }],
      }),
    );

    const lines = readLines(ndjsonPath);
    const last = lastRecordOfKind(lines, 'test-result') as unknown as TestResultRecord;
    expect(last.error?.name).toBe('WorkerCrash');
    expect(last.error?.message).toContain('SIGKILL');
  });

  it('matches the registry entry by testId + attempt (retries get a distinct entry)', () => {
    // Set up two entries for the same testId, different attempts.
    // The reporter must pick the one matching `result.retry + 1`.
    const first = setupTest({ testId: 'retry-id', attempt: 1, slug: 'retry-a-1' });
    const second = setupTest({ testId: 'retry-id', attempt: 2, slug: 'retry-a-2' });

    const reporter = newReporter();
    reporter.onTestEnd(
      fakeTestCase({ id: 'retry-id' }),
      fakeResult({ retry: 1, duration: 10, errors: [{ message: 'boom' }] }),
    );

    // Only the second-attempt NDJSON should have been touched.
    const firstLines = readLines(first.ndjsonPath);
    const secondLines = readLines(second.ndjsonPath);
    expect(firstLines.some((l) => l.includes('"test-result"'))).toBe(false);
    expect(secondLines.some((l) => l.includes('"test-result"'))).toBe(true);
  });

  it('keeps per-worker stderr buffers isolated across concurrent tests', () => {
    const a = setupTest({ testId: 'tid-A', slug: 'a' });
    const b = setupTest({ testId: 'tid-B', slug: 'b' });
    const reporter = newReporter();

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

    reporter.onTestEnd(
      fakeTestCase({ id: 'tid-A' }),
      fakeResult({ workerIndex: 0, duration: 100 }),
    );
    reporter.onTestEnd(
      fakeTestCase({ id: 'tid-B' }),
      fakeResult({
        workerIndex: 1,
        duration: 200,
        errors: [{ message: 'Worker process exited unexpectedly (code=1 signal=null)' }],
      }),
    );

    const lastA = lastRecordOfKind(
      readLines(a.ndjsonPath),
      'test-result',
    ) as unknown as TestResultRecord;
    const lastB = lastRecordOfKind(
      readLines(b.ndjsonPath),
      'test-result',
    ) as unknown as TestResultRecord;
    expect(lastA.error?.name).toBe('OutOfMemoryError');
    expect(lastB.error?.name).toBe('WorkerCrash');
    expect(lastA.stderr?.join('') ?? '').not.toContain('harmless debug log');
    expect(lastB.stderr?.join('') ?? '').not.toContain('heap out of memory');
  });

  it('clears the per-worker stderr buffer on onTestBegin so a fresh test does not inherit previous stderr', () => {
    const t1 = setupTest({ testId: 'tid-1', slug: 't1' });
    const t2 = setupTest({ testId: 'tid-2', slug: 't2' });
    const reporter = newReporter();

    reporter.onStdErr(
      'FATAL ERROR: JavaScript heap out of memory\n',
      undefined,
      fakeResult({ workerIndex: 0 }),
    );
    reporter.onTestEnd(
      fakeTestCase({ id: 'tid-1' }),
      fakeResult({ workerIndex: 0, duration: 100 }),
    );

    reporter.onTestBegin(fakeTestCase({ id: 'tid-2' }), fakeResult({ workerIndex: 0 }));
    reporter.onTestEnd(
      fakeTestCase({ id: 'tid-2' }),
      fakeResult({
        workerIndex: 0,
        duration: 200,
        status: 'failed',
        errors: [{ message: 'Worker process exited unexpectedly (code=1 signal=null)' }],
      }),
    );

    const last2 = lastRecordOfKind(
      readLines(t2.ndjsonPath),
      'test-result',
    ) as unknown as TestResultRecord;
    expect(last2.error?.name).toBe('WorkerCrash');
    expect(last2.stderr).toBeUndefined();

    // First test's NDJSON still got its own rescue, unaffected.
    const last1 = lastRecordOfKind(
      readLines(t1.ndjsonPath),
      'test-result',
    ) as unknown as TestResultRecord;
    expect(last1.error?.name).toBe('OutOfMemoryError');
  });

  it('swallows append errors and logs to process.stderr', () => {
    setupTest();
    const captured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;

    try {
      const reporter = newReporter({
        appendFile: () => {
          throw new Error('disk full');
        },
      });
      reporter.onTestEnd(fakeTestCase(), fakeResult({ duration: 1 }));
    } finally {
      process.stderr.write = origWrite;
    }

    expect(captured.join('')).toContain('failed to append synthetic test-result');
    expect(captured.join('')).toContain('disk full');
  });
});

describe('HealTracerReporter — attachments', () => {
  it('appends a test-attachments record on clean tests, with paths relative to the test outputDir', () => {
    const { ndjsonPath, rootDir } = setupTest({
      ndjsonContent:
        '{"kind":"test-header","schemaVersion":1}\n' +
        '{"kind":"test-result","status":"passed","duration":10}\n',
    });
    const reporter = newReporter();
    reporter.onTestEnd(
      fakeTestCase(),
      fakeResult({
        status: 'passed',
        duration: 10,
        attachments: [
          {
            name: 'trace',
            path: path.join(rootDir, 'trace.zip'),
            contentType: 'application/zip',
          },
          {
            name: 'video',
            path: path.join(rootDir, 'pages', 'page-1', 'video.webm'),
            contentType: 'video/webm',
          },
        ],
      } as unknown as Partial<TestResult>),
    );

    const lines = readLines(ndjsonPath);
    const last = JSON.parse(lines.at(-1)!) as {
      kind: string;
      attachments: { name: string; path: string; contentType: string }[];
    };
    expect(last.kind).toBe('test-attachments');
    expect(last.attachments).toEqual([
      { name: 'trace', path: 'trace.zip', contentType: 'application/zip' },
      {
        name: 'video',
        path: 'pages/page-1/video.webm',
        contentType: 'video/webm',
      },
    ]);
  });

  it('writes an empty test-attachments record when Playwright produced no attachments', () => {
    const { ndjsonPath } = setupTest({
      ndjsonContent:
        '{"kind":"test-header","schemaVersion":1}\n' +
        '{"kind":"test-result","status":"passed","duration":10}\n',
    });
    const reporter = newReporter();
    reporter.onTestEnd(fakeTestCase(), fakeResult({ status: 'passed', duration: 10 }));
    const last = JSON.parse(readLines(ndjsonPath).at(-1)!) as {
      kind: string;
      attachments: unknown[];
    };
    expect(last.kind).toBe('test-attachments');
    expect(last.attachments).toEqual([]);
  });

  it('drops attachments whose path falls outside the test outputDir', () => {
    const { ndjsonPath } = setupTest({
      ndjsonContent:
        '{"kind":"test-header","schemaVersion":1}\n' +
        '{"kind":"test-result","status":"passed","duration":10}\n',
    });
    const reporter = newReporter();
    reporter.onTestEnd(
      fakeTestCase(),
      fakeResult({
        status: 'passed',
        duration: 10,
        attachments: [
          {
            name: 'rogue',
            path: '/etc/passwd',
            contentType: 'text/plain',
          },
        ],
      } as unknown as Partial<TestResult>),
    );
    const last = JSON.parse(readLines(ndjsonPath).at(-1)!) as {
      attachments: unknown[];
    };
    expect(last.attachments).toEqual([]);
  });

  it('also appends test-attachments when rescuing a crashed test (after the synthetic test-result)', () => {
    const { ndjsonPath, rootDir } = setupTest();
    const reporter = newReporter();
    reporter.onTestEnd(
      fakeTestCase(),
      fakeResult({
        status: 'failed',
        duration: 100,
        errors: [{ message: 'Worker process exited unexpectedly' }],
        attachments: [
          {
            name: 'trace',
            path: path.join(rootDir, 'trace.zip'),
            contentType: 'application/zip',
          },
        ],
      } as unknown as Partial<TestResult>),
    );
    const lines = readLines(ndjsonPath);
    expect(lines.at(-2)).toContain('"test-result"');
    expect(lines.at(-1)).toContain('"test-attachments"');
  });

  it('cleans up the registry entry on every test end', () => {
    const { testId, attempt } = setupTest();
    const registryPath = healPendingRegistryPath(projectOutputDir, testId, attempt);
    expect(fs.existsSync(registryPath)).toBe(true);
    const reporter = newReporter();
    reporter.onTestEnd(fakeTestCase({ id: testId }), fakeResult());
    expect(fs.existsSync(registryPath)).toBe(false);
  });
});

describe('HealTracerReporter — onRescue hook', () => {
  it('invokes onRescue with the synthetic record and correlation context after a crash rescue', async () => {
    const { ndjsonPath, rootDir } = setupTest({ testId: 'tid-42' });
    const calls: Array<{ record: TestResultRecord; ctx: RescueContext }> = [];

    const reporter = newReporter({
      onRescue: (record, ctx) => {
        calls.push({ record, ctx });
      },
    });

    reporter.onTestEnd(
      fakeTestCase({ id: 'tid-42' }),
      fakeResult({
        workerIndex: 3,
        duration: 555,
        retry: 0,
        status: 'failed',
        errors: [{ message: 'Worker process exited unexpectedly (code=null signal=SIGKILL)' }],
      }),
    );

    // Hook fires from a microtask — wait two turns before asserting.
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0].record.kind).toBe('test-result');
    expect(calls[0].record.error?.name).toBe('WorkerCrash');
    expect(calls[0].ctx).toEqual({
      ndjsonPath,
      rootDir,
      testId: 'tid-42',
      attempt: 1,
      workerIndex: 3,
    });
  });

  it('does NOT invoke onRescue when the reporter short-circuits (NDJSON already terminated)', async () => {
    setupTest({
      ndjsonContent:
        '{"kind":"test-header","schemaVersion":1}\n' +
        '{"kind":"test-result","status":"passed","duration":10}\n',
    });
    let called = false;
    const reporter = newReporter({
      onRescue: () => {
        called = true;
      },
    });

    reporter.onTestEnd(fakeTestCase(), fakeResult({ status: 'passed', duration: 10 }));
    await Promise.resolve();
    expect(called).toBe(false);
  });

  it('does NOT invoke onRescue when the disk append fails', async () => {
    setupTest();
    let called = false;
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;

    try {
      const reporter = newReporter({
        appendFile: () => {
          throw new Error('disk full');
        },
        onRescue: () => {
          called = true;
        },
      });
      reporter.onTestEnd(fakeTestCase(), fakeResult({ duration: 1 }));
      await Promise.resolve();
    } finally {
      process.stderr.write = origWrite;
    }
    expect(called).toBe(false);
  });

  it('swallows onRescue hook errors and logs them to process.stderr', async () => {
    setupTest();
    const captured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;

    try {
      const reporter = newReporter({
        onRescue: () => Promise.reject(new Error('collector unreachable')),
      });
      reporter.onTestEnd(fakeTestCase(), fakeResult({ duration: 1 }));
      for (let i = 0; i < 5; i++) await Promise.resolve();
    } finally {
      process.stderr.write = origWrite;
    }

    expect(captured.join('')).toContain('onRescue hook failed');
    expect(captured.join('')).toContain('collector unreachable');
  });
});
