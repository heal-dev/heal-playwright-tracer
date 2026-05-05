/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  discoverExecutions,
  discoverTraces,
  isSafeIdForRouting,
  parseSummaryId,
} from '../../../src/infrastructure/local-viewer-adapter/discover-traces';

const HEADER = (overrides: Partial<{ title: string; testId: string; attempt: number }> = {}) => ({
  kind: 'test-header',
  schemaVersion: 1,
  test: {
    title: overrides.title ?? 'logs in',
    titlePath: ['auth', overrides.title ?? 'logs in'],
    file: 'tests/auth.spec.ts',
    project: 'chromium',
    workerIndex: 0,
    retry: 0,
    startedAt: 1714915200000,
    env: {},
    context: {
      testId: overrides.testId ?? 't-1',
      attempt: overrides.attempt ?? 1,
      executionId: 'exec-1',
    },
  },
});

const RESULT = {
  kind: 'test-result',
  status: 'passed',
  duration: 1234,
};

const ATTACH = (items: { name: string; path: string; contentType: string }[]) => ({
  kind: 'test-attachments',
  attachments: items,
});

const writeNdjson = async (
  rootDir: string,
  executionId: string,
  playwrightTestId: string,
  attempt: number,
  lines: object[],
): Promise<string> => {
  const dir = path.join(rootDir, 'heal-traces', executionId, playwrightTestId, String(attempt));
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'heal-traces.ndjson');
  await writeFile(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
  return filePath;
};

const writeExecutionsIndex = async (rootDir: string, lines: object[]): Promise<void> => {
  const dir = path.join(rootDir, 'heal-traces');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'executions.ndjson'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    'utf-8',
  );
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'heal-tracer-disc-'));
});

afterEach(async () => {
  /* tmpdir cleanup left to OS; tests use small fixtures */
});

describe('discoverTraces', () => {
  it('returns empty when the heal-traces tree is absent', async () => {
    const summaries = await discoverTraces(root, 'exec-x');
    expect(summaries).toEqual([]);
  });

  it('summarizes a single passing test under <exec>/<testId>/<attempt>/', async () => {
    await writeNdjson(root, 'exec-1', 't-1', 1, [HEADER(), RESULT]);
    const summaries = await discoverTraces(root, 'exec-1');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: 't-1_1',
      playwrightTestId: 't-1',
      attempt: 1,
      title: 'logs in',
      file: 'tests/auth.spec.ts',
      project: 'chromium',
      status: 'passed',
      duration: 1234,
    });
  });

  it('produces one summary per attempt directory', async () => {
    await writeNdjson(root, 'exec-1', 't-1', 1, [HEADER({ attempt: 1 }), RESULT]);
    await writeNdjson(root, 'exec-1', 't-1', 2, [HEADER({ attempt: 2 }), RESULT]);
    const summaries = await discoverTraces(root, 'exec-1');
    expect(summaries.map((s) => s.id).sort()).toEqual(['t-1_1', 't-1_2']);
  });

  it('exposes attachments from the test-attachments record', async () => {
    await writeNdjson(root, 'exec-1', 't-1', 1, [
      HEADER(),
      RESULT,
      ATTACH([
        { name: 'trace', path: 'trace.zip', contentType: 'application/zip' },
        { name: 'video', path: 'videos/video.webm', contentType: 'video/webm' },
      ]),
    ]);
    const [s] = await discoverTraces(root, 'exec-1');
    expect(s.attachments).toEqual([
      { name: 'trace', path: 'trace.zip', contentType: 'application/zip' },
      { name: 'video', path: 'videos/video.webm', contentType: 'video/webm' },
    ]);
  });

  it('marks status="unknown" when test-result is absent (worker crashed before finalize)', async () => {
    await writeNdjson(root, 'exec-1', 't-1', 1, [HEADER()]);
    const [s] = await discoverTraces(root, 'exec-1');
    expect(s.status).toBe('unknown');
    expect(s.duration).toBe(0);
  });

  it('skips attempt directories with malformed first line', async () => {
    const dir = path.join(root, 'heal-traces', 'exec-1', 't-1', '1');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'heal-traces.ndjson'), 'this is not json\n', 'utf-8');
    const summaries = await discoverTraces(root, 'exec-1');
    expect(summaries).toEqual([]);
  });

  it('only walks the requested execution', async () => {
    await writeNdjson(root, 'exec-1', 't-1', 1, [HEADER(), RESULT]);
    await writeNdjson(root, 'exec-2', 't-2', 1, [HEADER({ testId: 't-2' }), RESULT]);
    const summaries = await discoverTraces(root, 'exec-1');
    expect(summaries.map((s) => s.playwrightTestId)).toEqual(['t-1']);
  });
});

describe('discoverExecutions', () => {
  it('returns empty when heal-traces/ does not exist', async () => {
    const execs = await discoverExecutions(root);
    expect(execs).toEqual([]);
  });

  it('reads executions.ndjson and surfaces records newest-first by startedAt', async () => {
    await writeExecutionsIndex(root, [
      {
        kind: 'execution',
        executionId: 'older',
        source: 'env',
        startedAt: 100,
        endedAt: 110,
        durationMs: 10,
        totals: { tests: 1, passed: 1, failed: 0, timedOut: 0, skipped: 0, interrupted: 0 },
      },
      {
        kind: 'execution',
        executionId: 'newer',
        source: 'generated',
        startedAt: 500,
        endedAt: 520,
        durationMs: 20,
        totals: { tests: 2, passed: 1, failed: 1, timedOut: 0, skipped: 0, interrupted: 0 },
      },
    ]);
    const execs = await discoverExecutions(root);
    expect(execs.map((e) => e.executionId)).toEqual(['newer', 'older']);
    expect(execs[0].source).toBe('generated');
  });

  it('falls back to scanning subdirs and reading execution.json when index is missing', async () => {
    const dir = path.join(root, 'heal-traces', 'orphan');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'execution.json'),
      JSON.stringify({
        executionId: 'orphan',
        source: 'generated',
        startedAt: 50,
        endedAt: 60,
        durationMs: 10,
        totals: { tests: 0, passed: 0, failed: 0, timedOut: 0, skipped: 0, interrupted: 0 },
        tests: [],
      }),
      'utf-8',
    );
    const execs = await discoverExecutions(root);
    expect(execs).toHaveLength(1);
    expect(execs[0]).toMatchObject({
      executionId: 'orphan',
      source: 'generated',
      startedAt: 50,
    });
  });

  it('backfills disk-only executions alongside indexed ones', async () => {
    await writeExecutionsIndex(root, [
      {
        kind: 'execution',
        executionId: 'indexed',
        source: 'env',
        startedAt: 100,
        endedAt: 110,
        durationMs: 10,
        totals: { tests: 1, passed: 1, failed: 0, timedOut: 0, skipped: 0, interrupted: 0 },
      },
    ]);
    const orphanDir = path.join(root, 'heal-traces', 'orphan');
    await mkdir(orphanDir, { recursive: true });
    const execs = await discoverExecutions(root);
    const ids = execs.map((e) => e.executionId).sort();
    expect(ids).toEqual(['indexed', 'orphan']);
  });

  it('surfaces a degraded record when the manifest is unreadable', async () => {
    const dir = path.join(root, 'heal-traces', 'broken');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'execution.json'), 'not json{', 'utf-8');
    const execs = await discoverExecutions(root);
    expect(execs).toEqual([{ executionId: 'broken' }]);
  });
});

describe('parseSummaryId', () => {
  it('round-trips a simple id+attempt pair', () => {
    expect(parseSummaryId('abc_1')).toEqual({ playwrightTestId: 'abc', attempt: 1 });
  });

  it('splits on the LAST underscore so test ids may contain underscores', () => {
    expect(parseSummaryId('a_b_c_2')).toEqual({ playwrightTestId: 'a_b_c', attempt: 2 });
  });

  it('rejects malformed shapes', () => {
    expect(parseSummaryId('no-underscore')).toBeNull();
    expect(parseSummaryId('trailing_')).toBeNull();
    expect(parseSummaryId('_leading')).toBeNull();
    expect(parseSummaryId('abc_zero')).toBeNull();
    expect(parseSummaryId('abc_0')).toBeNull();
  });

  it('rejects unsafe characters', () => {
    expect(parseSummaryId('../etc_1')).toBeNull();
    expect(parseSummaryId('a/b_1')).toBeNull();
  });
});

describe('isSafeIdForRouting', () => {
  it('rejects path traversal and slashes', () => {
    expect(isSafeIdForRouting('ok-id')).toBe(true);
    expect(isSafeIdForRouting('..')).toBe(false);
    expect(isSafeIdForRouting('a/b')).toBe(false);
    expect(isSafeIdForRouting('a\\b')).toBe(false);
    expect(isSafeIdForRouting('')).toBe(false);
  });
});
