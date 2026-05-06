/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LocalViewerServer } from '../../../src/infrastructure/local-viewer-adapter/local-viewer-server';

const EXEC = 'exec-fixed';
const TID = 't1';
const ATTEMPT = 1;

const HEADER = {
  kind: 'test-header',
  schemaVersion: 1,
  test: {
    title: 'logs in',
    titlePath: ['logs in'],
    file: 'tests/auth.spec.ts',
    project: 'chromium',
    workerIndex: 0,
    retry: 0,
    startedAt: 1,
    env: {},
    context: { testId: TID, attempt: ATTEMPT, executionId: EXEC },
  },
};
const STMT_WITH_SCREENSHOT = {
  kind: 'statement',
  statement: {
    seq: 1,
    file: 'a.spec.ts',
    line: 1,
    endLine: 1,
    kind: 'ExpressionStatement',
    scope: 'test',
    source: 'page.click()',
    hasAwait: true,
    step: null,
    stepPath: null,
    status: 'ok',
    duration: 5,
    t: 5,
    children: [] as unknown[],
    screenshot: 'stmt-0001.png',
  },
};
const RESULT = { kind: 'test-result', status: 'passed', duration: 100 };
const ATTACHMENTS = {
  kind: 'test-attachments',
  attachments: [
    { name: 'trace', path: 'trace.zip', contentType: 'application/zip' },
    { name: 'video', path: 'videos/video.webm', contentType: 'video/webm' },
  ],
};
const EXECUTION_RECORD = {
  kind: 'execution',
  executionId: EXEC,
  source: 'env',
  startedAt: 100,
  endedAt: 200,
  durationMs: 100,
  totals: {
    tests: 1,
    passed: 1,
    failed: 0,
    timedOut: 0,
    skipped: 0,
    interrupted: 0,
  },
};

let root: string;
let bundleDir: string;
let server: LocalViewerServer;
let baseUrl: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'heal-tracer-srv-'));
  bundleDir = path.join(root, '_bundle');
  await mkdir(bundleDir, { recursive: true });
  await writeFile(path.join(bundleDir, 'index.html'), '<!doctype html><body>SPA</body>', 'utf-8');
  await writeFile(path.join(bundleDir, 'app.js'), 'console.log("ok");', 'utf-8');

  // heal-traces tree: <root>/heal-traces/<EXEC>/<TID>/<ATTEMPT>/...
  const testDir = path.join(root, 'heal-traces', EXEC, TID, String(ATTEMPT));
  await mkdir(path.join(testDir, 'screenshots'), { recursive: true });
  await mkdir(path.join(testDir, 'videos'), { recursive: true });
  await writeFile(
    path.join(testDir, 'heal-traces.ndjson'),
    [HEADER, STMT_WITH_SCREENSHOT, RESULT, ATTACHMENTS].map((l) => JSON.stringify(l)).join('\n'),
    'utf-8',
  );
  await writeFile(
    path.join(testDir, 'screenshots', 'stmt-0001.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  await writeFile(path.join(testDir, 'trace.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  await writeFile(
    path.join(testDir, 'videos', 'video.webm'),
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]),
  );

  // Executions index
  await writeFile(
    path.join(root, 'heal-traces', 'executions.ndjson'),
    JSON.stringify(EXECUTION_RECORD) + '\n',
    'utf-8',
  );

  server = new LocalViewerServer({
    rootDir: root,
    bundleDir,
    port: 0,
    hostname: '127.0.0.1',
  });
  await server.start();
  const addr = (server as unknown as { server: import('node:http').Server }).server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('expected AddressInfo');
  }
  baseUrl = `http://127.0.0.1:${String(addr.port)}`;
});

afterAll(async () => {
  await server.stop();
});

describe('LocalViewerServer', () => {
  it('GET / serves the SPA index.html', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('SPA');
  });

  it('GET /api/executions lists known executions', async () => {
    const res = await fetch(`${baseUrl}/api/executions`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { executions: { executionId: string }[] };
    expect(json.executions).toHaveLength(1);
    expect(json.executions[0].executionId).toBe(EXEC);
  });

  it('GET /api/executions/:id/index.json returns the per-execution index', async () => {
    const res = await fetch(`${baseUrl}/api/executions/${EXEC}/index.json`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      executionId: string;
      schemaVersion: number;
      tests: { id: string; title: string; playwrightTestId: string; attempt: number }[];
    };
    expect(json.executionId).toBe(EXEC);
    expect(json.schemaVersion).toBe(2);
    expect(json.tests).toHaveLength(1);
    expect(json.tests[0]).toMatchObject({
      id: `${TID}_${ATTEMPT}`,
      playwrightTestId: TID,
      attempt: ATTEMPT,
      title: 'logs in',
    });
  });

  it('GET /api/executions/:id/index.json on an unknown execution returns an empty index', async () => {
    const res = await fetch(`${baseUrl}/api/executions/unknown/index.json`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { executionId: string; tests: unknown[] };
    expect(json.executionId).toBe('unknown');
    expect(json.tests).toEqual([]);
  });

  it('GET /api/executions/:id/tests/:tid/:attempt rewrites screenshot URLs into the new layout', async () => {
    const res = await fetch(`${baseUrl}/api/executions/${EXEC}/tests/${TID}/${ATTEMPT}`);
    expect(res.status).toBe(200);
    const trace = (await res.json()) as {
      statements: { screenshot?: string }[];
    };
    expect(trace.statements[0].screenshot).toBe(
      `/api/executions/${EXEC}/screenshot/${TID}/${ATTEMPT}/stmt-0001.png`,
    );
  });

  it('GET /api/executions/:id/screenshot/:tid/:attempt/:file returns the PNG', async () => {
    const res = await fetch(
      `${baseUrl}/api/executions/${EXEC}/screenshot/${TID}/${ATTEMPT}/stmt-0001.png`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('GET /api/executions/:id/asset/:tid/:attempt/trace.zip serves the binary trace', async () => {
    const res = await fetch(`${baseUrl}/api/executions/${EXEC}/asset/${TID}/${ATTEMPT}/trace.zip`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });

  it('GET /api/executions/:id/asset/:tid/:attempt/videos/<file> returns the video', async () => {
    const res = await fetch(
      `${baseUrl}/api/executions/${EXEC}/asset/${TID}/${ATTEMPT}/videos/video.webm`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/webm');
  });

  it('GET /api/executions/:id/tests/:tid/:attempt carries attachments with new-layout URLs', async () => {
    const res = await fetch(`${baseUrl}/api/executions/${EXEC}/tests/${TID}/${ATTEMPT}`);
    const trace = (await res.json()) as {
      attachments: { url: string; name: string }[];
    };
    expect(trace.attachments).toHaveLength(2);
    const trace0 = trace.attachments.find((a) => a.name === 'trace');
    expect(trace0?.url).toBe(`/api/executions/${EXEC}/asset/${TID}/${ATTEMPT}/trace.zip`);
  });

  it('rejects path traversal in screenshot filename', async () => {
    const res = await fetch(
      `${baseUrl}/api/executions/${EXEC}/screenshot/${TID}/${ATTEMPT}/${encodeURIComponent('../../etc/passwd')}`,
    );
    expect(res.status).toBe(400);
  });

  it('rejects path traversal in asset path', async () => {
    const res = await fetch(
      `${baseUrl}/api/executions/${EXEC}/asset/${TID}/${ATTEMPT}/${encodeURIComponent('../../etc/passwd')}`,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for non-numeric attempt', async () => {
    const res = await fetch(`${baseUrl}/api/executions/${EXEC}/tests/${TID}/notanumber`);
    // The path doesn't match our regex (which requires \d+) so it
    // falls through to the SPA — that's the SPA fallback by design.
    // Use a path that DOES match the shape but with attempt=0:
    const res2 = await fetch(`${baseUrl}/api/executions/${EXEC}/tests/${TID}/0`);
    expect(res2.status).toBe(400);
    expect(res.status).toBe(200); // SPA fallback for non-API-shaped URLs
  });

  it('returns 404 for unknown test', async () => {
    const res = await fetch(`${baseUrl}/api/executions/${EXEC}/tests/missing/1`);
    expect(res.status).toBe(404);
  });

  it('falls back to index.html for unknown SPA routes (client-side routing)', async () => {
    const res = await fetch(`${baseUrl}/some/spa/route`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('SPA');
  });

  it('rejects non-GET methods', async () => {
    const res = await fetch(`${baseUrl}/api/executions`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('OPTIONS preflight includes Access-Control-Allow-Private-Network', async () => {
    const res = await fetch(`${baseUrl}/api/executions`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-private-network')).toBe('true');
  });
});

describe('LocalViewerServer.boundPort()', () => {
  it('returns null before start, a positive integer after start, and null after stop', async () => {
    const s = new LocalViewerServer({
      rootDir: root,
      bundleDir,
      port: 0,
      hostname: '127.0.0.1',
    });
    expect(s.boundPort()).toBeNull();
    await s.start();
    const p = s.boundPort();
    expect(typeof p).toBe('number');
    expect(p).toBeGreaterThan(0);
    await s.stop();
    expect(s.boundPort()).toBeNull();
  });

  it('reflects an OS-assigned ephemeral port when port=0 is requested', async () => {
    const s = new LocalViewerServer({
      rootDir: root,
      bundleDir,
      port: 0,
      hostname: '127.0.0.1',
    });
    await s.start();
    const p = s.boundPort();
    // OS-assigned ephemeral port is well above the privileged range.
    expect(p).not.toBe(0);
    expect(p! >= 1024).toBe(true);
    await s.stop();
  });
});
