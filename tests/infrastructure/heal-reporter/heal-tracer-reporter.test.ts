/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { FullConfig, TestCase, TestResult } from '@playwright/test/reporter';
import {
  HealTracerReporter,
  HEAL_PENDING_SUBDIR,
  healPendingRegistryPath,
  type RescueContext,
  type AttachmentsContext,
} from '../../../src/infrastructure/heal-reporter';
import type {
  TestAttachmentsRecord,
  TestResultRecord,
} from '../../../src/domain/trace-event-recorder/model/statement-trace-schema';

let tmpDir: string;
let projectOutputDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-reporter-'));
  projectOutputDir = path.join(tmpDir, 'test-results');
  fs.mkdirSync(projectOutputDir, { recursive: true });
  delete process.env.HEAL_TRACER_REPORTER;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HEAL_TRACER_REPORTER;
});

// Per-test helpers that mirror the fixture's contract:
//   - rootDir            heal-traces destination dir, where the
//                        ndjson lives and the reporter copies
//                        attachments into.
//   - playwrightOutputDir source dir Playwright wrote its own
//                        attachments into; the reporter reads from
//                        here and copies into rootDir.
// The fixture writes the registry entry pointing at both.
function setupTest(
  opts: {
    testId?: string;
    attempt?: number;
    ndjsonContent?: string | null;
    slug?: string;
    executionId?: string;
  } = {},
): {
  ndjsonPath: string;
  rootDir: string;
  playwrightOutputDir: string;
  testId: string;
  attempt: number;
  executionId: string;
} {
  const testId = opts.testId ?? 'tid-abc';
  const attempt = opts.attempt ?? 1;
  const slug = opts.slug ?? `${testId}-${attempt}`;
  const executionId = opts.executionId ?? 'exec-1';
  const rootDir = path.join(tmpDir, 'heal-traces', executionId, testId, String(attempt));
  fs.mkdirSync(rootDir, { recursive: true });
  const ndjsonPath = path.join(rootDir, 'heal-traces.ndjson');
  if (opts.ndjsonContent !== null) {
    fs.writeFileSync(
      ndjsonPath,
      opts.ndjsonContent ?? '{"kind":"test-header","schemaVersion":1}\n',
    );
  }
  const playwrightOutputDir = path.join(projectOutputDir, slug);
  fs.mkdirSync(playwrightOutputDir, { recursive: true });
  const registryPath = healPendingRegistryPath(projectOutputDir, testId, attempt);
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(
    registryPath,
    JSON.stringify({ ndjsonPath, rootDir, playwrightOutputDir, executionId }),
  );
  return { ndjsonPath, rootDir, playwrightOutputDir, testId, attempt, executionId };
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

describe('HealTracerReporter — onBegin handshake', () => {
  it('sets HEAL_TRACER_REPORTER=1 so worker fixtures can detect registration', () => {
    expect(process.env.HEAL_TRACER_REPORTER).toBeUndefined();
    new HealTracerReporter().onBegin?.(fakeConfig(), {} as never);
    expect(process.env.HEAL_TRACER_REPORTER).toBe('1');
  });
});

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
      JSON.stringify({
        ndjsonPath: '/nowhere/heal-traces.ndjson',
        rootDir: '/nowhere',
        playwrightOutputDir: '/nowhere/pw',
        executionId: 'exec-x',
      }),
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

  it('swallows append errors and logs them via the unified logger', () => {
    setupTest();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const reporter = newReporter({
      appendFile: () => {
        throw new Error('disk full');
      },
    });
    reporter.onTestEnd(fakeTestCase(), fakeResult({ duration: 1 }));

    const messages = errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    errSpy.mockRestore();

    expect(messages.some((m: string) => m.includes('failed to append synthetic test-result'))).toBe(
      true,
    );
    expect(messages.some((m: string) => m.includes('disk full'))).toBe(true);
  });
});

describe('HealTracerReporter — attachments', () => {
  // Helper: drop a small file at <playwrightOutputDir>/<rel> so the
  // reporter's copy step has something to read.
  function writeSrc(playwrightOutputDir: string, rel: string, body = 'x'): string {
    const abs = path.join(playwrightOutputDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
    return abs;
  }

  it('copies trace.zip and videos into the heal-traces tree, paths relative to the per-attempt dir', () => {
    const { ndjsonPath, rootDir, playwrightOutputDir } = setupTest({
      ndjsonContent:
        '{"kind":"test-header","schemaVersion":1}\n' +
        '{"kind":"test-result","status":"passed","duration":10}\n',
    });
    const traceSrc = writeSrc(playwrightOutputDir, 'trace.zip', 'TRACE');
    const videoSrc = writeSrc(
      playwrightOutputDir,
      path.join('pages', 'page-1', 'video.webm'),
      'VIDEO',
    );
    const reporter = newReporter();
    reporter.onTestEnd(
      fakeTestCase(),
      fakeResult({
        status: 'passed',
        duration: 10,
        attachments: [
          { name: 'trace', path: traceSrc, contentType: 'application/zip' },
          { name: 'video', path: videoSrc, contentType: 'video/webm' },
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
        path: 'videos/video.webm',
        contentType: 'video/webm',
      },
    ]);

    // Files actually landed in the heal-traces tree.
    expect(fs.readFileSync(path.join(rootDir, 'trace.zip'), 'utf8')).toBe('TRACE');
    expect(fs.readFileSync(path.join(rootDir, 'videos', 'video.webm'), 'utf8')).toBe('VIDEO');
  });

  it('stamps pageName/pageUrl onto video attachments via the registry videoPages map', () => {
    const { ndjsonPath, playwrightOutputDir, testId, attempt } = setupTest({
      ndjsonContent:
        '{"kind":"test-header","schemaVersion":1}\n' +
        '{"kind":"test-result","status":"passed","duration":10}\n',
    });
    const traceSrc = writeSrc(playwrightOutputDir, 'trace.zip', 'TRACE');
    const videoSrc = writeSrc(playwrightOutputDir, 'video.webm', 'VIDEO');

    // Simulate the fixture's teardown re-write of the registry entry.
    const registryPath = healPendingRegistryPath(projectOutputDir, testId, attempt);
    const base = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        ...base,
        videoPages: [{ name: 'main', url: 'https://example.com/checkout' }],
      }),
    );

    const reporter = newReporter();
    reporter.onTestEnd(
      fakeTestCase(),
      fakeResult({
        status: 'passed',
        duration: 10,
        attachments: [
          { name: 'trace', path: traceSrc, contentType: 'application/zip' },
          { name: 'video', path: videoSrc, contentType: 'video/webm' },
        ],
      } as unknown as Partial<TestResult>),
    );

    const lines = readLines(ndjsonPath);
    const last = JSON.parse(lines.at(-1)!) as {
      attachments: Array<{
        name: string;
        path: string;
        contentType: string;
        pageName?: string;
        pageUrl?: string;
      }>;
    };
    // Video is enriched; the trace attachment is left untouched.
    expect(last.attachments).toEqual([
      { name: 'trace', path: 'trace.zip', contentType: 'application/zip' },
      {
        name: 'video',
        path: 'videos/video.webm',
        contentType: 'video/webm',
        pageName: 'main',
        pageUrl: 'https://example.com/checkout',
      },
    ]);
  });

  it('leaves video attachments un-enriched when videoPages is malformed', () => {
    const { ndjsonPath, playwrightOutputDir, testId, attempt } = setupTest({
      ndjsonContent:
        '{"kind":"test-header","schemaVersion":1}\n' +
        '{"kind":"test-result","status":"passed","duration":10}\n',
    });
    const videoSrc = writeSrc(playwrightOutputDir, 'video.webm', 'VIDEO');

    const registryPath = healPendingRegistryPath(projectOutputDir, testId, attempt);
    const base = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(registryPath, JSON.stringify({ ...base, videoPages: 'not-an-array' }));

    const reporter = newReporter();
    reporter.onTestEnd(
      fakeTestCase(),
      fakeResult({
        status: 'passed',
        duration: 10,
        attachments: [{ name: 'video', path: videoSrc, contentType: 'video/webm' }],
      } as unknown as Partial<TestResult>),
    );

    const last = JSON.parse(readLines(ndjsonPath).at(-1)!) as {
      attachments: Array<{ name: string; path: string; contentType: string }>;
    };
    expect(last.attachments).toEqual([
      { name: 'video', path: 'videos/video.webm', contentType: 'video/webm' },
    ]);
  });

  it('pairs the Nth video attachment with videoPages[N] (positional join)', () => {
    const { ndjsonPath, playwrightOutputDir, testId, attempt } = setupTest({
      ndjsonContent:
        '{"kind":"test-header","schemaVersion":1}\n' +
        '{"kind":"test-result","status":"passed","duration":10}\n',
    });
    // Two pages → two videos. Playwright names them differently in
    // outputDir (`video.webm`, `video-1.webm`) but the reporter joins
    // by position, not by name.
    const mainSrc = writeSrc(playwrightOutputDir, 'video.webm', 'MAIN');
    const popupSrc = writeSrc(playwrightOutputDir, 'video-1.webm', 'POPUP');

    const registryPath = healPendingRegistryPath(projectOutputDir, testId, attempt);
    const base = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        ...base,
        videoPages: [
          { name: 'main', url: 'https://app.test/home' },
          { name: 'page-1', url: 'https://app.test/oauth' },
        ],
      }),
    );

    const reporter = newReporter();
    reporter.onTestEnd(
      fakeTestCase(),
      fakeResult({
        status: 'passed',
        duration: 10,
        attachments: [
          { name: 'video', path: mainSrc, contentType: 'video/webm' },
          { name: 'video', path: popupSrc, contentType: 'video/webm' },
        ],
      } as unknown as Partial<TestResult>),
    );

    const last = JSON.parse(readLines(ndjsonPath).at(-1)!) as {
      attachments: Array<{ name: string; pageName?: string; pageUrl?: string }>;
    };
    expect(last.attachments).toEqual([
      {
        name: 'video',
        path: 'videos/video.webm',
        contentType: 'video/webm',
        pageName: 'main',
        pageUrl: 'https://app.test/home',
      },
      {
        name: 'video',
        path: 'videos/video-1.webm',
        contentType: 'video/webm',
        pageName: 'page-1',
        pageUrl: 'https://app.test/oauth',
      },
    ]);
  });

  it('leaves a surplus video un-enriched when fewer videoPages entries than video attachments', () => {
    const { ndjsonPath, playwrightOutputDir, testId, attempt } = setupTest({
      ndjsonContent:
        '{"kind":"test-header","schemaVersion":1}\n' +
        '{"kind":"test-result","status":"passed","duration":10}\n',
    });
    const aSrc = writeSrc(playwrightOutputDir, 'video.webm', 'A');
    const bSrc = writeSrc(playwrightOutputDir, 'video-1.webm', 'B');

    const registryPath = healPendingRegistryPath(projectOutputDir, testId, attempt);
    const base = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        ...base,
        // Only one entry — the second video attachment has no pair.
        // Defensive: covers a popup closed before fixture teardown so
        // its `page.video()` returned null but Playwright still
        // finalized the file later.
        videoPages: [{ name: 'main', url: 'https://app.test/home' }],
      }),
    );

    const reporter = newReporter();
    reporter.onTestEnd(
      fakeTestCase(),
      fakeResult({
        status: 'passed',
        duration: 10,
        attachments: [
          { name: 'video', path: aSrc, contentType: 'video/webm' },
          { name: 'video', path: bSrc, contentType: 'video/webm' },
        ],
      } as unknown as Partial<TestResult>),
    );

    const last = JSON.parse(readLines(ndjsonPath).at(-1)!) as {
      attachments: Array<{ name: string; pageName?: string; pageUrl?: string }>;
    };
    expect(last.attachments).toEqual([
      {
        name: 'video',
        path: 'videos/video.webm',
        contentType: 'video/webm',
        pageName: 'main',
        pageUrl: 'https://app.test/home',
      },
      // Surplus video — no pair in videoPages, stays un-enriched.
      { name: 'video', path: 'videos/video-1.webm', contentType: 'video/webm' },
    ]);
  });

  it('drops individual malformed videoPages entries while keeping valid ones', () => {
    const { ndjsonPath, playwrightOutputDir, testId, attempt } = setupTest({
      ndjsonContent:
        '{"kind":"test-header","schemaVersion":1}\n' +
        '{"kind":"test-result","status":"passed","duration":10}\n',
    });
    const aSrc = writeSrc(playwrightOutputDir, 'video.webm', 'A');
    const bSrc = writeSrc(playwrightOutputDir, 'video-1.webm', 'B');

    const registryPath = healPendingRegistryPath(projectOutputDir, testId, attempt);
    const base = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        ...base,
        videoPages: [
          null,
          'string-item',
          { name: 'page-1' }, // missing `url`
          { name: 'main', url: 'https://app.test/ok' },
        ],
      }),
    );

    const reporter = newReporter();
    reporter.onTestEnd(
      fakeTestCase(),
      fakeResult({
        status: 'passed',
        duration: 10,
        attachments: [
          { name: 'video', path: aSrc, contentType: 'video/webm' },
          { name: 'video', path: bSrc, contentType: 'video/webm' },
        ],
      } as unknown as Partial<TestResult>),
    );

    const last = JSON.parse(readLines(ndjsonPath).at(-1)!) as {
      attachments: Array<{ name: string; pageName?: string; pageUrl?: string }>;
    };
    // Sanitization drops the three malformed entries → only the
    // well-formed entry survives at videoPages[0], so the FIRST video
    // attachment is enriched. The second has no pair → un-enriched.
    expect(last.attachments).toEqual([
      {
        name: 'video',
        path: 'videos/video.webm',
        contentType: 'video/webm',
        pageName: 'main',
        pageUrl: 'https://app.test/ok',
      },
      { name: 'video', path: 'videos/video-1.webm', contentType: 'video/webm' },
    ]);
  });

  it("places Playwright's failure screenshot under the screenshots/ subdir", () => {
    const { ndjsonPath, rootDir, playwrightOutputDir } = setupTest({
      ndjsonContent:
        '{"kind":"test-header","schemaVersion":1}\n' +
        '{"kind":"test-result","status":"failed","duration":10}\n',
    });
    const shotSrc = writeSrc(playwrightOutputDir, 'test-failed-1.png', 'PNG');
    const reporter = newReporter();
    reporter.onTestEnd(
      fakeTestCase(),
      fakeResult({
        status: 'failed',
        duration: 10,
        attachments: [{ name: 'screenshot', path: shotSrc, contentType: 'image/png' }],
      } as unknown as Partial<TestResult>),
    );

    const last = JSON.parse(readLines(ndjsonPath).at(-1)!) as {
      attachments: { name: string; path: string; contentType: string }[];
    };
    expect(last.attachments).toEqual([
      { name: 'screenshot', path: 'screenshots/test-failed-1.png', contentType: 'image/png' },
    ]);
    expect(fs.readFileSync(path.join(rootDir, 'screenshots', 'test-failed-1.png'), 'utf8')).toBe(
      'PNG',
    );
  });

  it('preserves subdirs for non-trace, non-video attachments (e.g. user testInfo.attach)', () => {
    const { ndjsonPath, rootDir, playwrightOutputDir } = setupTest({
      ndjsonContent:
        '{"kind":"test-header","schemaVersion":1}\n' +
        '{"kind":"test-result","status":"passed","duration":10}\n',
    });
    const userSrc = writeSrc(
      playwrightOutputDir,
      path.join('user-attachments', 'foo.json'),
      '{"a":1}',
    );
    const reporter = newReporter();
    reporter.onTestEnd(
      fakeTestCase(),
      fakeResult({
        status: 'passed',
        duration: 10,
        attachments: [
          {
            name: 'foo',
            path: userSrc,
            contentType: 'application/json',
          },
        ],
      } as unknown as Partial<TestResult>),
    );
    const last = JSON.parse(readLines(ndjsonPath).at(-1)!) as {
      attachments: { name: string; path: string; contentType: string }[];
    };
    expect(last.attachments[0].path).toBe('user-attachments/foo.json');
    expect(fs.readFileSync(path.join(rootDir, 'user-attachments', 'foo.json'), 'utf8')).toBe(
      '{"a":1}',
    );
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

  it('drops attachments whose source path falls outside Playwright outputDir', () => {
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

  it('also copies + appends attachments when rescuing a crashed test (after the synthetic test-result)', () => {
    const { ndjsonPath, rootDir, playwrightOutputDir } = setupTest();
    const traceSrc = writeSrc(playwrightOutputDir, 'trace.zip', 'CRASH-TRACE');
    const reporter = newReporter();
    reporter.onTestEnd(
      fakeTestCase(),
      fakeResult({
        status: 'failed',
        duration: 100,
        errors: [{ message: 'Worker process exited unexpectedly' }],
        attachments: [{ name: 'trace', path: traceSrc, contentType: 'application/zip' }],
      } as unknown as Partial<TestResult>),
    );
    const lines = readLines(ndjsonPath);
    expect(lines.at(-2)).toContain('"test-result"');
    expect(lines.at(-1)).toContain('"test-attachments"');
    expect(fs.readFileSync(path.join(rootDir, 'trace.zip'), 'utf8')).toBe('CRASH-TRACE');
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
    expect(calls[0].ctx).toMatchObject({
      ndjsonPath,
      rootDir,
      testId: 'tid-42',
      attempt: 1,
      workerIndex: 3,
      executionId: 'exec-1',
    });
    expect(typeof calls[0].ctx.playwrightOutputDir).toBe('string');
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
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

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
      errSpy.mockRestore();
    }
    expect(called).toBe(false);
  });

  it('swallows onRescue hook errors and logs them via the unified logger', async () => {
    setupTest();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const reporter = newReporter({
      onRescue: () => Promise.reject(new Error('collector unreachable')),
    });
    reporter.onTestEnd(fakeTestCase(), fakeResult({ duration: 1 }));
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const messages = errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    errSpy.mockRestore();

    expect(messages.some((m: string) => m.includes('onRescue hook failed'))).toBe(true);
    expect(messages.some((m: string) => m.includes('collector unreachable'))).toBe(true);
  });
});

describe('HealTracerReporter — onAttachmentsWritten hook', () => {
  it('invokes the hook with the test-attachments record + correlation context after a clean append', async () => {
    const { ndjsonPath, rootDir, playwrightOutputDir } = setupTest({
      testId: 'tid-42',
      ndjsonContent:
        '{"kind":"test-header","schemaVersion":1}\n' +
        '{"kind":"test-result","status":"passed","duration":10}\n',
    });
    const calls: Array<{ record: TestAttachmentsRecord; ctx: AttachmentsContext }> = [];

    const reporter = newReporter({
      onAttachmentsWritten: (record, ctx) => {
        calls.push({ record, ctx });
      },
    });

    reporter.onTestEnd(
      fakeTestCase({ id: 'tid-42' }),
      fakeResult({ workerIndex: 5, status: 'passed', duration: 10, retry: 0 }),
    );

    // Hook fires from a microtask — wait two turns before asserting.
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0].record.kind).toBe('test-attachments');
    expect(Array.isArray(calls[0].record.attachments)).toBe(true);
    expect(calls[0].ctx).toMatchObject({
      ndjsonPath,
      rootDir,
      playwrightOutputDir,
      executionId: 'exec-1',
      testId: 'tid-42',
      attempt: 1,
      workerIndex: 5,
    });
  });

  it('does NOT invoke the hook when no registry entry exists for the test', async () => {
    // No setupTest() — registry is empty, traceCtx is null, the
    // reporter short-circuits before reaching the hook site.
    let called = false;
    const reporter = newReporter({
      onAttachmentsWritten: () => {
        called = true;
      },
    });
    reporter.onTestEnd(fakeTestCase(), fakeResult({ status: 'passed', duration: 1 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(called).toBe(false);
  });

  it('does NOT invoke the hook when the test-attachments append fails', async () => {
    setupTest({
      ndjsonContent:
        '{"kind":"test-header","schemaVersion":1}\n' +
        '{"kind":"test-result","status":"passed","duration":10}\n',
    });
    let called = false;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const reporter = newReporter({
        appendFile: () => {
          throw new Error('disk full');
        },
        onAttachmentsWritten: () => {
          called = true;
        },
      });
      reporter.onTestEnd(fakeTestCase(), fakeResult({ status: 'passed', duration: 1 }));
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      errSpy.mockRestore();
    }
    expect(called).toBe(false);
  });

  it('swallows hook errors and logs them via the unified logger', async () => {
    setupTest({
      ndjsonContent:
        '{"kind":"test-header","schemaVersion":1}\n' +
        '{"kind":"test-result","status":"passed","duration":10}\n',
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const reporter = newReporter({
      onAttachmentsWritten: () => Promise.reject(new Error('collector unreachable')),
    });
    reporter.onTestEnd(fakeTestCase(), fakeResult({ status: 'passed', duration: 1 }));
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const messages = errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    errSpy.mockRestore();

    expect(messages.some((m: string) => m.includes('onAttachmentsWritten hook failed'))).toBe(true);
    expect(messages.some((m: string) => m.includes('collector unreachable'))).toBe(true);
  });

  it('awaits in-flight hook promises in onEnd so trailing artefact shipping is not lost', async () => {
    setupTest({
      ndjsonContent:
        '{"kind":"test-header","schemaVersion":1}\n' +
        '{"kind":"test-result","status":"passed","duration":10}\n',
    });
    let hookResolved = false;
    const reporter = newReporter({
      onAttachmentsWritten: () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            hookResolved = true;
            resolve();
          }, 30),
        ),
    });
    reporter.onTestEnd(fakeTestCase(), fakeResult({ status: 'passed', duration: 1 }));

    // Without the onEnd await, the hook would still be in-flight here.
    expect(hookResolved).toBe(false);

    // onEnd returns a Promise (the reporter is now async on this hook).
    await reporter.onEnd?.();

    expect(hookResolved).toBe(true);
  });
});
