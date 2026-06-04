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
// Root statement is in the spec file; its child runs in the imported
// `pages/login.ts` helper — so the derived `source[]` lists both, with
// the spec flagged as entry.
const STMT_WITH_SCREENSHOT = {
  kind: 'statement',
  statement: {
    seq: 1,
    file: 'tests/auth.spec.ts',
    line: 2,
    endLine: 2,
    kind: 'ExpressionStatement',
    scope: 'test',
    source: 'login()',
    hasAwait: true,
    step: null,
    stepPath: null,
    status: 'ok',
    duration: 5,
    t: 5,
    pageId: 'ctx0/p0',
    children: [
      {
        seq: 2,
        file: 'pages/login.ts',
        line: 1,
        endLine: 1,
        kind: 'CallExpression',
        scope: 'login',
        source: 'export const login = () => {}',
        hasAwait: false,
        step: null,
        stepPath: null,
        status: 'ok',
        duration: 1,
        t: 6,
        children: [] as unknown[],
      },
    ] as unknown[],
    screenshot: 'stmt-0001.png',
  },
};
const RESULT = { kind: 'test-result', status: 'passed', duration: 100 };
const ATTACHMENTS = {
  kind: 'test-attachments',
  attachments: [
    { name: 'trace', path: 'trace.zip', contentType: 'application/zip' },
    {
      name: 'video',
      path: 'videos/video.webm',
      contentType: 'video/webm',
      pageId: 'ctx0/p0',
      videoStartWallMs: 1,
      pageName: 'main',
      pageUrl: 'https://app.test/home',
    },
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

  // Source files live in the working tree (rootDir), NOT in the trace
  // dir — the viewer reads them live. `.env` exists in root but is not
  // referenced by the trace; the source endpoint must refuse to serve it.
  await mkdir(path.join(root, 'tests'), { recursive: true });
  await mkdir(path.join(root, 'pages'), { recursive: true });
  await writeFile(
    path.join(root, 'tests', 'auth.spec.ts'),
    "import { login } from '../pages/login';\nlogin();\n",
    'utf-8',
  );
  await writeFile(
    path.join(root, 'pages', 'login.ts'),
    'export const login = () => {};\n',
    'utf-8',
  );
  await writeFile(path.join(root, '.env'), 'SECRET=hunter2\n', 'utf-8');
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
    expect(json.schemaVersion).toBe(4);
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

  it('advertises Accept-Ranges on a full asset response', async () => {
    const res = await fetch(
      `${baseUrl}/api/executions/${EXEC}/asset/${TID}/${ATTEMPT}/videos/video.webm`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
  });

  it('honors a Range request with 206 Partial Content (video timeline seeking)', async () => {
    const res = await fetch(
      `${baseUrl}/api/executions/${EXEC}/asset/${TID}/${ATTEMPT}/videos/video.webm`,
      { headers: { Range: 'bytes=2-5' } },
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-type')).toBe('video/webm');
    // video.webm is 8 bytes: bytes 2-5 inclusive = 4 bytes.
    expect(res.headers.get('content-range')).toBe('bytes 2-5/8');
    expect(res.headers.get('content-length')).toBe('4');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(new Uint8Array([0xdf, 0xa3, 0x9f, 0x42]));
  });

  it('clamps an open-ended Range to the last byte', async () => {
    const res = await fetch(
      `${baseUrl}/api/executions/${EXEC}/asset/${TID}/${ATTEMPT}/videos/video.webm`,
      { headers: { Range: 'bytes=4-' } },
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 4-7/8');
    expect(res.headers.get('content-length')).toBe('4');
  });

  it('serves a suffix Range (last N bytes)', async () => {
    const res = await fetch(
      `${baseUrl}/api/executions/${EXEC}/asset/${TID}/${ATTEMPT}/videos/video.webm`,
      { headers: { Range: 'bytes=-3' } },
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 5-7/8');
    expect(res.headers.get('content-length')).toBe('3');
  });

  it('answers 416 for an unsatisfiable Range', async () => {
    const res = await fetch(
      `${baseUrl}/api/executions/${EXEC}/asset/${TID}/${ATTEMPT}/videos/video.webm`,
      { headers: { Range: 'bytes=99-200' } },
    );
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */8');
    await res.arrayBuffer();
  });

  it('ignores a malformed Range header and serves the full file', async () => {
    const res = await fetch(
      `${baseUrl}/api/executions/${EXEC}/asset/${TID}/${ATTEMPT}/videos/video.webm`,
      { headers: { Range: 'bytes=abc' } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('8');
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

  it('surfaces pageId / videoStartWallMs / pageName on the video attachment (not on the trace)', async () => {
    const res = await fetch(`${baseUrl}/api/executions/${EXEC}/tests/${TID}/${ATTEMPT}`);
    const trace = (await res.json()) as {
      attachments: {
        name: string;
        contentType: string;
        pageId?: string;
        videoStartWallMs?: number;
        pageName?: string;
      }[];
    };
    const video = trace.attachments.find((a) => a.contentType.startsWith('video/'))!;
    expect(video.pageId).toBe('ctx0/p0');
    expect(video.videoStartWallMs).toBe(1);
    expect(video.pageName).toBe('main');
    // The trace attachment carries none of the video-only fields.
    const traceAtt = trace.attachments.find((a) => a.name === 'trace')!;
    expect(traceAtt.pageId).toBeUndefined();
    expect(traceAtt.videoStartWallMs).toBeUndefined();
  });

  it('stamps videoTime on statements joined to their page video (clamped, only when pageId matches)', async () => {
    const res = await fetch(`${baseUrl}/api/executions/${EXEC}/tests/${TID}/${ATTEMPT}`);
    const trace = (await res.json()) as {
      statements: { videoTime?: number; children: { videoTime?: number }[] }[];
    };
    // header.startedAt=1, root t=5, video anchor videoStartWallMs=1
    // → (1 + 5 − 1) / 1000.
    expect(trace.statements[0].videoTime).toBe((1 + 5 - 1) / 1000);
    // The child statement has no pageId → no videoTime.
    expect(trace.statements[0].children[0].videoTime).toBeUndefined();
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

  // --- /source/... endpoint --------------------------------------------

  it('GET /api/.../tests/:tid/:attempt derives source[] from statements, spec first', async () => {
    const res = await fetch(`${baseUrl}/api/executions/${EXEC}/tests/${TID}/${ATTEMPT}`);
    const trace = (await res.json()) as {
      source: { url: string; path: string; bytes: number; entry?: boolean }[];
    };
    expect(trace.source).toHaveLength(2);
    const spec = trace.source[0];
    expect(spec.path).toBe('tests/auth.spec.ts');
    expect(spec.entry).toBe(true);
    expect(spec.url).toBe(`/api/executions/${EXEC}/source/${TID}/${ATTEMPT}/tests/auth.spec.ts`);
    // bytes are the LIVE file's size, stat'd from the working tree.
    expect(spec.bytes).toBeGreaterThan(0);
    const login = trace.source.find((s) => s.path === 'pages/login.ts');
    expect(login?.entry).toBeUndefined();
  });

  it('GET /api/.../source/:tid/:attempt/<path> streams the live spec file', async () => {
    const res = await fetch(
      `${baseUrl}/api/executions/${EXEC}/source/${TID}/${ATTEMPT}/tests/auth.spec.ts`,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("import { login } from '../pages/login'");
  });

  it('GET source for a nested referenced file streams it from the working tree', async () => {
    const res = await fetch(
      `${baseUrl}/api/executions/${EXEC}/source/${TID}/${ATTEMPT}/pages/login.ts`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('export const login');
  });

  it('refuses to serve a repo file the trace does not reference (e.g. .env)', async () => {
    // `.env` exists under rootDir but no statement references it — the
    // membership guard must 404 it despite the permissive CORS policy.
    const res = await fetch(`${baseUrl}/api/executions/${EXEC}/source/${TID}/${ATTEMPT}/.env`);
    expect(res.status).toBe(404);
  });

  it('rejects path traversal in source path', async () => {
    const res = await fetch(
      `${baseUrl}/api/executions/${EXEC}/source/${TID}/${ATTEMPT}/${encodeURIComponent('../../etc/passwd')}`,
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

  // --- /api/exec routes ------------------------------------------------

  it('POST /api/exec with disallowed bin returns 403', async () => {
    const res = await fetch(`${baseUrl}/api/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bin: 'bash', args: [] }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
  });

  it('POST /api/exec with allowed bin returns 200 + jobId (spawn entrypoint)', async () => {
    // The spawn will fail with ENOENT (no `heal` binary in tests), but
    // the endpoint replies 200 because the failure surfaces async via
    // GET /api/exec/:jobId. This only proves the allowlist + spawn
    // entrypoint accept the request.
    const res = await fetch(`${baseUrl}/api/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bin: 'heal', args: ['whoami', '--json'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobId: string };
    expect(body.jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('POST /api/exec with invalid JSON body returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bin:',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
  });

  it('POST /api/exec with malformed body shape returns 400', async () => {
    const cases: unknown[] = [
      {},
      { bin: 'heal' },
      { bin: 'heal', args: 'whoami' },
      { bin: 42, args: [] },
      { bin: 'heal', args: [1, 2, 3] },
    ];
    for (const c of cases) {
      const res = await fetch(`${baseUrl}/api/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(c),
      });
      expect(res.status, `case=${JSON.stringify(c)}`).toBe(400);
    }
  });

  it('POST /api/exec with oversized body is rejected (cap enforced)', async () => {
    // The 64 KB cap is enforced mid-stream by destroying the request.
    // From the client side this surfaces as either:
    //   - a 400 response with `{ error: 'Request body too large' }` (if
    //     the response made it out before the socket was destroyed), or
    //   - a fetch failure (socket closed mid-write).
    // Both outcomes prove the cap is enforced; we accept either.
    const big = { bin: 'heal', args: ['x'.repeat(65 * 1024)] };
    let status: number | 'fetch-failed' = 'fetch-failed';
    let errorBody: string | null = null;
    try {
      const res = await fetch(`${baseUrl}/api/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(big),
      });
      status = res.status;
      try {
        const j = (await res.json()) as { error?: string };
        errorBody = j.error ?? null;
      } catch {
        errorBody = await res.text().catch(() => null);
      }
    } catch {
      status = 'fetch-failed';
    }
    if (status === 'fetch-failed') {
      expect(status).toBe('fetch-failed');
    } else {
      expect(status).toBe(400);
      expect((errorBody ?? '').toLowerCase()).toContain('too large');
    }
  });

  it('GET /api/exec/:jobId for unknown id returns 404 with error body', async () => {
    const res = await fetch(`${baseUrl}/api/exec/00000000-0000-0000-0000-000000000000`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Unknown jobId');
  });

  it('GET /api/exec/:jobId for known id returns 200 + snapshot shape', async () => {
    const post = await fetch(`${baseUrl}/api/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bin: 'heal', args: ['whoami'] }),
    });
    expect(post.status).toBe(200);
    const { jobId } = (await post.json()) as { jobId: string };

    const res = await fetch(`${baseUrl}/api/exec/${jobId}`);
    expect(res.status).toBe(200);
    const snap = (await res.json()) as {
      jobId: string;
      status: string;
      exitCode: number | null;
      stdout: unknown;
      stderr: unknown;
    };
    expect(snap.jobId).toBe(jobId);
    expect(['running', 'exited']).toContain(snap.status);
    expect(Array.isArray(snap.stdout)).toBe(true);
    expect(Array.isArray(snap.stderr)).toBe(true);
    expect(snap.exitCode === null || typeof snap.exitCode === 'number').toBe(true);
  });

  it('GET /api/exec without id falls through (no method gate hit)', async () => {
    // GET /api/exec doesn't match the /api/exec/:jobId regex; it
    // falls through past every API matcher and reaches serveStatic,
    // which (for an extensionless path) SPA-falls-back to index.html.
    const res = await fetch(`${baseUrl}/api/exec`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('SPA');
  });

  it('POST /api/executions still rejected (method gate)', async () => {
    const res = await fetch(`${baseUrl}/api/executions`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  // --- serveStatic asset-vs-SPA behaviour -----------------------------

  it('GET /missing.js returns 404 (not SPA fallback)', async () => {
    const res = await fetch(`${baseUrl}/missing.js`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain('SPA');
  });

  it('GET /missing.css returns 404', async () => {
    const res = await fetch(`${baseUrl}/missing.css`);
    expect(res.status).toBe(404);
  });

  it('GET /missing.png returns 404', async () => {
    const res = await fetch(`${baseUrl}/missing.png`);
    expect(res.status).toBe(404);
  });

  it('GET /deep/path/missing.js returns 404 (nested asset-looking path)', async () => {
    const res = await fetch(`${baseUrl}/deep/path/missing.js`);
    expect(res.status).toBe(404);
  });

  it('GET /unknown/deep/path (extensionless) still SPA-falls-back to index.html', async () => {
    const res = await fetch(`${baseUrl}/unknown/deep/path`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('SPA');
  });

  it('GET /index.html returns 200 with index.html content', async () => {
    const res = await fetch(`${baseUrl}/index.html`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('SPA');
  });

  it('GET /app.js serves the bundled asset with JS MIME', async () => {
    const res = await fetch(`${baseUrl}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
    const body = await res.text();
    expect(body).toContain('console.log');
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

// ───────────────────────────────────────────────────────────────────
// /api/.../analyze endpoints. Tests that need a live `heal` process
// (the "started-only + alive job → running" case) are intentionally
// skipped — exercising that path would require a fake `heal` binary
// since POST hardcodes the bin. The shape covered here is the full
// file-state machine, plus POST validation.
// ───────────────────────────────────────────────────────────────────

interface AnalyzeStatusBody {
  status: 'running' | 'completed' | 'failed';
  verdict?: { verdictType: string; failingStatementIndex: number; description: string };
  message?: string;
  events?: { event: string; timestamp: number }[];
}

const analyzeDir = (testId: string): string => path.join(root, 'heal-traces', EXEC, testId, '1');

const writeAnalyzeFile = async (testId: string, lines: string[]): Promise<void> => {
  await mkdir(analyzeDir(testId), { recursive: true });
  await writeFile(path.join(analyzeDir(testId), 'analyze.ndjson'), lines.join('\n'), 'utf-8');
};

const analyzeUrl = (testId: string): string =>
  `${baseUrl}/api/executions/${EXEC}/tests/${testId}/1/analyze`;

describe('LocalViewerServer analyze endpoints', () => {
  it('POST analyze returns 200 + jobId for valid params', async () => {
    const res = await fetch(analyzeUrl('t-analyze-post-ok'), { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobId: string };
    expect(body.jobId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('POST analyze rejects an unsafe executionId with 400', async () => {
    // `foo..bar` matches the route regex but trips isSafeIdForRouting's
    // `..`-include check. A whole-segment `..` would be normalized away
    // by WHATWG URL parsing before reaching our code.
    const res = await fetch(`${baseUrl}/api/executions/foo..bar/tests/t1/1/analyze`, {
      method: 'POST',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('executionId');
  });

  it('POST analyze rejects an unsafe testId with 400', async () => {
    const res = await fetch(`${baseUrl}/api/executions/${EXEC}/tests/foo..bar/1/analyze`, {
      method: 'POST',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('playwrightTestId');
  });

  it('POST analyze rejects a non-numeric attempt with 405 (no route match)', async () => {
    // The route regex requires \d+ for the attempt segment; a non-numeric
    // value misses the route entirely and falls through to the static
    // handler. Lock that behaviour in.
    const res = await fetch(`${baseUrl}/api/executions/${EXEC}/tests/t1/abc/analyze`, {
      method: 'POST',
    });
    // POST on a path that doesn't match the analyze route gets 405 from
    // the generic method gate.
    expect([404, 405]).toContain(res.status);
  });

  it('GET analyze rejects an unsafe executionId with 400', async () => {
    const res = await fetch(`${baseUrl}/api/executions/foo..bar/tests/t1/1/analyze`);
    expect(res.status).toBe(400);
  });

  it('GET analyze returns 404 when there is no file and no recorded job', async () => {
    const testId = 't-analyze-missing';
    // Don't write a file, don't POST — purely "no analyze for this test".
    const res = await fetch(analyzeUrl(testId));
    expect(res.status).toBe(404);
  });

  it('GET analyze returns `completed` when the file has a terminal verdict', async () => {
    const testId = 't-analyze-verdict';
    await writeAnalyzeFile(testId, [
      JSON.stringify({ event: 'started', timestamp: 1 }),
      JSON.stringify({
        event: 'verdict',
        timestamp: 2,
        verdict: {
          verdictType: 'BUG',
          failingStatementIndex: 3,
          description: 'click did not navigate',
          reasoning: 'expected URL to change',
          model: 'opus-4.6-high',
          latencyMs: 24210,
        },
      }),
    ]);
    const res = await fetch(analyzeUrl(testId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnalyzeStatusBody;
    expect(body.status).toBe('completed');
    expect(body.verdict?.verdictType).toBe('BUG');
    expect(body.verdict?.failingStatementIndex).toBe(3);
    expect(body.events).toHaveLength(2);
  });

  it('GET analyze returns `failed` when the file has a terminal error', async () => {
    const testId = 't-analyze-error';
    await writeAnalyzeFile(testId, [
      JSON.stringify({ event: 'started', timestamp: 1 }),
      JSON.stringify({ event: 'error', timestamp: 2, message: 'LLM call timed out' }),
    ]);
    const res = await fetch(analyzeUrl(testId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnalyzeStatusBody;
    expect(body.status).toBe('failed');
    expect(body.message).toBe('LLM call timed out');
    expect(body.events).toHaveLength(2);
  });

  it('GET analyze returns `failed` (crash) when only `started` is present and no job is alive', async () => {
    const testId = 't-analyze-crash';
    await writeAnalyzeFile(testId, [JSON.stringify({ event: 'started', timestamp: 1 })]);
    const res = await fetch(analyzeUrl(testId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnalyzeStatusBody;
    expect(body.status).toBe('failed');
    expect(body.message).toMatch(/without writing a terminal event/);
    expect(body.events).toHaveLength(1);
  });

  it('GET analyze ignores garbage lines and returns the verdict found among them', async () => {
    const testId = 't-analyze-garbage';
    await writeAnalyzeFile(testId, [
      'not-json',
      JSON.stringify({ event: 'started', timestamp: 1 }),
      '{ unterminated',
      JSON.stringify({
        event: 'verdict',
        timestamp: 2,
        verdict: {
          verdictType: 'NO_VERDICT',
          failingStatementIndex: 0,
          description: 'could not determine',
        },
      }),
    ]);
    const res = await fetch(analyzeUrl(testId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnalyzeStatusBody;
    expect(body.status).toBe('completed');
    expect(body.verdict?.verdictType).toBe('NO_VERDICT');
  });
});
