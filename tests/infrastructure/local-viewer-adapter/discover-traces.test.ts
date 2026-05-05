/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildIndex,
  discoverTraces,
  isSafeIdForRouting,
  writeIndex,
} from '../../../src/infrastructure/local-viewer-adapter/discover-traces';

const HEADER = {
  kind: 'test-header',
  schemaVersion: 1,
  test: {
    title: 'logs in',
    titlePath: ['auth', 'logs in'],
    file: 'tests/auth.spec.ts',
    project: 'chromium',
    workerIndex: 0,
    retry: 0,
    startedAt: 1714915200000,
    env: {},
    context: { testId: 't-1', attempt: 1 },
  },
};

const RESULT = {
  kind: 'test-result',
  status: 'passed',
  duration: 1234,
};

const writeNdjson = async (rootDir: string, testDir: string, lines: object[]): Promise<void> => {
  const dir = path.join(rootDir, testDir, 'heal-data');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'heal-traces.ndjson'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    'utf-8',
  );
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'heal-tracer-disc-'));
});

afterEach(async () => {
  // Tests use small fixtures; node will GC. Skip explicit rm to keep
  // the test surface minimal — same convention as other tracer tests.
});

describe('discoverTraces', () => {
  it('returns empty array when rootDir does not exist', async () => {
    const summaries = await discoverTraces(path.join(root, 'missing'));
    expect(summaries).toEqual([]);
  });

  it('returns empty array when no test directories contain heal-traces.ndjson', async () => {
    await mkdir(path.join(root, 'some-other-dir'), { recursive: true });
    const summaries = await discoverTraces(root);
    expect(summaries).toEqual([]);
  });

  it('summarizes a single passing test from header + result', async () => {
    await writeNdjson(root, 'auth-spec-logs-in-chromium', [HEADER, RESULT]);
    const summaries = await discoverTraces(root);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: 'auth-spec-logs-in-chromium',
      title: 'logs in',
      file: 'tests/auth.spec.ts',
      project: 'chromium',
      attempt: 1,
      status: 'passed',
      duration: 1234,
      ndjsonPath: path.join('auth-spec-logs-in-chromium', 'heal-data', 'heal-traces.ndjson'),
    });
  });

  const ATTACH = (items: { name: string; path: string; contentType: string }[]) => ({
    kind: 'test-attachments',
    attachments: items,
  });

  it('derives videos from test-attachments where contentType is video/*', async () => {
    await writeNdjson(root, 'video-test', [
      HEADER,
      RESULT,
      ATTACH([{ name: 'video', path: 'video.webm', contentType: 'video/webm' }]),
    ]);
    const summaries = await discoverTraces(root);
    expect(summaries[0].videos).toEqual([{ file: 'video.webm', label: 'video.webm' }]);
    expect(summaries[0].attachments).toEqual([
      { name: 'video', path: 'video.webm', contentType: 'video/webm' },
    ]);
  });

  it('returns empty videos AND empty attachments when test-attachments is absent (reporter not registered)', async () => {
    await writeNdjson(root, 'no-attachments-record', [HEADER, RESULT]);
    const summaries = await discoverTraces(root);
    expect(summaries[0].videos).toEqual([]);
    expect(summaries[0].attachments).toEqual([]);
  });

  it('returns empty videos when test-attachments contains no video MIME types', async () => {
    await writeNdjson(root, 'only-trace', [
      HEADER,
      RESULT,
      ATTACH([{ name: 'trace', path: 'trace.zip', contentType: 'application/zip' }]),
    ]);
    const summaries = await discoverTraces(root);
    expect(summaries[0].videos).toEqual([]);
  });

  it('lists multiple videos alphabetically by relative path', async () => {
    await writeNdjson(root, 'multi-video', [
      HEADER,
      RESULT,
      ATTACH([
        { name: 'video', path: 'b.webm', contentType: 'video/webm' },
        { name: 'video', path: 'a.webm', contentType: 'video/webm' },
      ]),
    ]);
    const summaries = await discoverTraces(root);
    expect(summaries[0].videos.map((v) => v.file)).toEqual(['a.webm', 'b.webm']);
  });

  it('surfaces .mp4 videos via the video/mp4 MIME type', async () => {
    await writeNdjson(root, 'mp4-test', [
      HEADER,
      RESULT,
      ATTACH([{ name: 'video', path: 'video.mp4', contentType: 'video/mp4' }]),
    ]);
    const summaries = await discoverTraces(root);
    expect(summaries[0].videos).toEqual([{ file: 'video.mp4', label: 'video.mp4' }]);
  });

  it('preserves nested per-page video paths from the attachment record', async () => {
    await writeNdjson(root, 'multi-page', [
      HEADER,
      RESULT,
      ATTACH([
        {
          name: 'video',
          path: 'pages/page-1/video.webm',
          contentType: 'video/webm',
        },
      ]),
    ]);
    const summaries = await discoverTraces(root);
    expect(summaries[0].videos).toEqual([{ file: 'pages/page-1/video.webm', label: 'video.webm' }]);
  });

  it('exposes the full attachments list — trace.zip, video, screenshots, etc.', async () => {
    await writeNdjson(root, 'all-attachments', [
      HEADER,
      RESULT,
      ATTACH([
        { name: 'trace', path: 'trace.zip', contentType: 'application/zip' },
        { name: 'video', path: 'video.webm', contentType: 'video/webm' },
        {
          name: 'screenshot',
          path: 'test-failed-1.png',
          contentType: 'image/png',
        },
      ]),
    ]);
    const summaries = await discoverTraces(root);
    expect(summaries[0].attachments).toHaveLength(3);
    expect(summaries[0].videos).toHaveLength(1);
  });

  it('marks a partial trace as status "unknown" when test-result is absent', async () => {
    await writeNdjson(root, 'crashed-test', [HEADER]);
    const summaries = await discoverTraces(root);
    expect(summaries[0].status).toBe('unknown');
    expect(summaries[0].duration).toBe(0);
  });

  it('skips test directories with malformed first line', async () => {
    const dir = path.join(root, 'bad-test', 'heal-data');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'heal-traces.ndjson'), 'this is not json\n', 'utf-8');
    const summaries = await discoverTraces(root);
    expect(summaries).toEqual([]);
  });

  it('sanitizes id characters that would be unsafe to use in a URL', async () => {
    await writeNdjson(root, 'auth spec [chromium]', [HEADER, RESULT]);
    const summaries = await discoverTraces(root);
    expect(summaries[0].id).toBe('auth_spec_chromium_');
    expect(isSafeIdForRouting(summaries[0].id)).toBe(true);
  });

  it('finds heal-data at deeper paths than one level (recursive walk)', async () => {
    await writeNdjson(root, path.join('packages', 'pkg-a', 'test-results', 'auth-spec'), [
      HEADER,
      RESULT,
    ]);
    const summaries = await discoverTraces(root);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe('packages_pkg-a_test-results_auth-spec');
    expect(summaries[0].ndjsonPath).toBe(
      path.join(
        'packages',
        'pkg-a',
        'test-results',
        'auth-spec',
        'heal-data',
        'heal-traces.ndjson',
      ),
    );
  });

  it('discovers multiple heal-data dirs at varying depths with distinct ids', async () => {
    await writeNdjson(root, 'flat', [HEADER, RESULT]);
    await writeNdjson(root, path.join('nested', 'deep', 'auth'), [HEADER, RESULT]);
    const summaries = await discoverTraces(root);
    expect(summaries).toHaveLength(2);
    const ids = summaries.map((s) => s.id).sort();
    expect(ids).toEqual(['flat', 'nested_deep_auth']);
  });

  it('prunes node_modules even when it contains heal-data inside', async () => {
    await writeNdjson(root, path.join('node_modules', 'some-pkg', 'test-results', 'spec'), [
      HEADER,
      RESULT,
    ]);
    const summaries = await discoverTraces(root);
    expect(summaries).toEqual([]);
  });

  it('prunes .git, dist, coverage, .next, .cache, .turbo, .vercel', async () => {
    for (const noise of ['.git', 'dist', 'coverage', '.next', '.cache', '.turbo', '.vercel']) {
      await writeNdjson(root, path.join(noise, 'maybe-traces', 'spec'), [HEADER, RESULT]);
    }
    const summaries = await discoverTraces(root);
    expect(summaries).toEqual([]);
  });

  it('does not follow symlinks (avoids loops)', async () => {
    // Real trace at depth 1
    await writeNdjson(root, 'real-spec', [HEADER, RESULT]);
    // Symlink loop: link -> root itself
    await symlink(root, path.join(root, 'loop'));
    const summaries = await discoverTraces(root);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe('real-spec');
  });

  it('collects sibling retries (same depth, distinct dir names)', async () => {
    await writeNdjson(root, 'auth-spec-attempt-1', [
      { ...HEADER, test: { ...HEADER.test, context: { testId: 't', attempt: 1 } } },
      RESULT,
    ]);
    await writeNdjson(root, 'auth-spec-retry1-attempt-2', [
      { ...HEADER, test: { ...HEADER.test, context: { testId: 't', attempt: 2 } } },
      RESULT,
    ]);
    const summaries = await discoverTraces(root);
    expect(summaries).toHaveLength(2);
    expect(summaries.map((s) => s.id).sort()).toEqual([
      'auth-spec-attempt-1',
      'auth-spec-retry1-attempt-2',
    ]);
  });

  it('orders results by file → attempt → title', async () => {
    await writeNdjson(root, 't1-attempt2', [
      {
        ...HEADER,
        test: { ...HEADER.test, file: 'b.spec.ts', context: { testId: 't', attempt: 2 } },
      },
      RESULT,
    ]);
    await writeNdjson(root, 't1-attempt1', [
      {
        ...HEADER,
        test: { ...HEADER.test, file: 'b.spec.ts', context: { testId: 't', attempt: 1 } },
      },
      RESULT,
    ]);
    await writeNdjson(root, 't0', [
      { ...HEADER, test: { ...HEADER.test, file: 'a.spec.ts' } },
      RESULT,
    ]);
    const summaries = await discoverTraces(root);
    expect(summaries.map((s) => s.file)).toEqual(['a.spec.ts', 'b.spec.ts', 'b.spec.ts']);
    expect(summaries.slice(1).map((s) => s.attempt)).toEqual([1, 2]);
  });
});

describe('buildIndex / writeIndex', () => {
  it('wraps summaries in a versioned envelope', async () => {
    await writeNdjson(root, 'a-test', [HEADER, RESULT]);
    const summaries = await discoverTraces(root);
    const index = buildIndex(summaries);
    expect(index.schemaVersion).toBe(1);
    expect(index.tests).toBe(summaries);
  });

  it('writes _viewer-index.json at the root with pretty JSON', async () => {
    await writeNdjson(root, 'a-test', [HEADER, RESULT]);
    const summaries = await discoverTraces(root);
    await writeIndex(root, summaries);
    const written = await readFile(path.join(root, '_viewer-index.json'), 'utf-8');
    const parsed = JSON.parse(written) as {
      schemaVersion: number;
      tests: unknown[];
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.tests).toHaveLength(1);
  });
});

describe('isSafeIdForRouting', () => {
  it('rejects path traversal and separators', () => {
    expect(isSafeIdForRouting('..')).toBe(false);
    expect(isSafeIdForRouting('a/b')).toBe(false);
    expect(isSafeIdForRouting('a\\b')).toBe(false);
    expect(isSafeIdForRouting('')).toBe(false);
  });

  it('accepts plain alphanumerics, underscores, dashes, and dots', () => {
    expect(isSafeIdForRouting('test_1.attempt-2')).toBe(true);
  });
});
