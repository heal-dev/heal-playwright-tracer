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
    context: { testId: 't1', attempt: 1 },
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
    { name: 'video', path: 'video.webm', contentType: 'video/webm' },
    {
      name: 'video',
      path: 'pages/page-1/video.webm',
      contentType: 'video/webm',
    },
  ],
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

  // Single-test fixture
  const dataDir = path.join(root, 'logs-in', 'heal-data');
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    path.join(dataDir, 'heal-traces.ndjson'),
    [HEADER, STMT_WITH_SCREENSHOT, RESULT, ATTACHMENTS].map((l) => JSON.stringify(l)).join('\n'),
    'utf-8',
  );
  await writeFile(
    path.join(dataDir, 'stmt-0001.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  // trace.zip + two videos referenced from ATTACHMENTS.
  await writeFile(path.join(root, 'logs-in', 'trace.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  await writeFile(
    path.join(root, 'logs-in', 'video.webm'),
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]),
  );
  await mkdir(path.join(root, 'logs-in', 'pages', 'page-1'), {
    recursive: true,
  });
  await writeFile(
    path.join(root, 'logs-in', 'pages', 'page-1', 'video.webm'),
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  );

  server = new LocalViewerServer({
    rootDir: root,
    bundleDir,
    port: 0, // any free port; we read the actual port after listen
    hostname: '127.0.0.1',
  });
  // Bind to port 0 → read assigned port back. Patch the underlying
  // server after start() resolves.
  await server.start();
  // The server starts listening on the OS-assigned port; expose it
  // by reading the AddressInfo via the underlying http.Server.
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

  it('GET /api/index.json returns versioned envelope with discovered tests', async () => {
    const res = await fetch(`${baseUrl}/api/index.json`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      schemaVersion: number;
      tests: { id: string; title: string }[];
    };
    expect(json.schemaVersion).toBe(1);
    expect(json.tests).toHaveLength(1);
    expect(json.tests[0].title).toBe('logs in');
  });

  it('GET /api/trace/:id rewrites screenshot filenames to URLs', async () => {
    const indexRes = await fetch(`${baseUrl}/api/index.json`);
    const index = (await indexRes.json()) as { tests: { id: string }[] };
    const id = index.tests[0].id;
    const res = await fetch(`${baseUrl}/api/trace/${encodeURIComponent(id)}`);
    expect(res.status).toBe(200);
    const trace = (await res.json()) as {
      statements: { screenshot?: string }[];
    };
    expect(trace.statements[0].screenshot).toMatch(
      new RegExp(`^/api/screenshot/${id}/stmt-0001\\.png$`),
    );
  });

  it('GET /api/screenshot/:id/:file returns the binary PNG', async () => {
    const indexRes = await fetch(`${baseUrl}/api/index.json`);
    const index = (await indexRes.json()) as { tests: { id: string }[] };
    const id = index.tests[0].id;
    const res = await fetch(`${baseUrl}/api/screenshot/${encodeURIComponent(id)}/stmt-0001.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('rejects path traversal in screenshot filename', async () => {
    const indexRes = await fetch(`${baseUrl}/api/index.json`);
    const index = (await indexRes.json()) as { tests: { id: string }[] };
    const id = index.tests[0].id;
    const res = await fetch(
      `${baseUrl}/api/screenshot/${encodeURIComponent(id)}/${encodeURIComponent('../../etc/passwd')}`,
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown trace id', async () => {
    const res = await fetch(`${baseUrl}/api/trace/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it('falls back to index.html for unknown SPA routes (client-side routing)', async () => {
    const res = await fetch(`${baseUrl}/some/spa/route`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('SPA');
  });

  it('rejects non-GET methods', async () => {
    const res = await fetch(`${baseUrl}/api/index.json`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('GET /api/trace/:id includes video URLs (rewritten to /api/asset)', async () => {
    const indexRes = await fetch(`${baseUrl}/api/index.json`);
    const index = (await indexRes.json()) as { tests: { id: string }[] };
    const id = index.tests[0].id;
    const res = await fetch(`${baseUrl}/api/trace/${encodeURIComponent(id)}`);
    const trace = (await res.json()) as {
      videos: { url: string; label: string }[];
    };
    expect(trace.videos.map((v) => v.url).sort()).toEqual([
      `/api/asset/${id}/pages/page-1/video.webm`,
      `/api/asset/${id}/video.webm`,
    ]);
    expect(trace.videos.every((v) => v.label === 'video.webm')).toBe(true);
  });

  it('GET /api/trace/:id carries the full attachments list with rewritten URLs', async () => {
    const indexRes = await fetch(`${baseUrl}/api/index.json`);
    const index = (await indexRes.json()) as { tests: { id: string }[] };
    const id = index.tests[0].id;
    const res = await fetch(`${baseUrl}/api/trace/${encodeURIComponent(id)}`);
    const trace = (await res.json()) as {
      attachments: {
        url: string;
        name: string;
        path: string;
        contentType: string;
      }[];
    };
    expect(trace.attachments).toHaveLength(3);
    const trace0 = trace.attachments.find((a) => a.name === 'trace');
    expect(trace0?.url).toBe(`/api/asset/${id}/trace.zip`);
    expect(trace0?.contentType).toBe('application/zip');
  });

  it('GET /api/asset/:id/trace.zip serves the binary trace file', async () => {
    const indexRes = await fetch(`${baseUrl}/api/index.json`);
    const index = (await indexRes.json()) as { tests: { id: string }[] };
    const id = index.tests[0].id;
    const res = await fetch(`${baseUrl}/api/asset/${encodeURIComponent(id)}/trace.zip`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });

  it('GET /api/video/:id/:file returns the binary video', async () => {
    const indexRes = await fetch(`${baseUrl}/api/index.json`);
    const index = (await indexRes.json()) as { tests: { id: string }[] };
    const id = index.tests[0].id;
    const res = await fetch(`${baseUrl}/api/video/${encodeURIComponent(id)}/video.webm`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/webm');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
  });

  it('GET /api/video/:id/<nested>/video.webm serves nested per-page videos', async () => {
    const indexRes = await fetch(`${baseUrl}/api/index.json`);
    const index = (await indexRes.json()) as { tests: { id: string }[] };
    const id = index.tests[0].id;
    const res = await fetch(
      `${baseUrl}/api/video/${encodeURIComponent(id)}/pages/page-1/video.webm`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/webm');
  });

  it('rejects path traversal in video filename', async () => {
    const indexRes = await fetch(`${baseUrl}/api/index.json`);
    const index = (await indexRes.json()) as { tests: { id: string }[] };
    const id = index.tests[0].id;
    const res = await fetch(
      `${baseUrl}/api/video/${encodeURIComponent(id)}/${encodeURIComponent('../../etc/passwd')}`,
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown video id', async () => {
    const res = await fetch(`${baseUrl}/api/video/does-not-exist/video.webm`);
    expect(res.status).toBe(404);
  });
});
