/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Local-only HTTP server for the trace viewer. Routes mirror the
// on-disk layout 1:1:
//
//   GET /api/executions
//   GET /api/executions/:executionId/index.json
//   GET /api/executions/:executionId/tests/:playwrightTestId/:attempt
//   GET /api/executions/:executionId/asset/:playwrightTestId/:attempt/<path>
//   GET /api/executions/:executionId/screenshot/:playwrightTestId/:attempt/<file>
//
// `:playwrightTestId` is Playwright's `testInfo.testId`; `:attempt`
// is 1-indexed. Together they identify exactly one
// `<rootDir>/heal-traces/<executionId>/<playwrightTestId>/<attempt>/`
// directory on disk.
//
// No third-party deps — Node's built-in `http` is enough. The SPA is
// the trust boundary: every URL parameter is run through a path-
// traversal guard before we touch the filesystem.

import { createReadStream, statSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';

import { HealTracesLayout } from '../heal-traces-layout';

import { loadAnalyzeNdjson } from './analyze-ndjson-loader';
import {
  buildIndex,
  discoverExecutions,
  discoverTraces,
  isSafeIdForRouting,
} from './discover-traces';
import { ExecJobManager } from './exec-job-manager';
import type {
  AnalyzeRunStartResponse,
  AnalyzeRunStatus,
  ApiErrorResponse,
  AttachmentRef,
  ExecJobSnapshot,
  ExecSpawnResponse,
  ExecutionSummary,
  ExecutionsResponse,
  IndexResponse,
  TestSummary,
  TraceResponse,
} from './local-server-api-types';
import { loadTrace, rewriteScreenshots } from './ndjson-trace-loader';

const EXEC_BODY_MAX_BYTES = 64 * 1024;

// The viewer's auth chip only ever spawns `heal whoami` / `heal login`
// — this OSS tracer is the entry point to the paid heal-cli funnel.
const ALLOWED_EXEC_BIN = 'heal';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
  '.zip': 'application/zip',
  '.md': 'text/markdown; charset=utf-8',
};

const getMime = (filePath: string): string =>
  MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';

const sendJson = (res: http.ServerResponse, status: number, body: unknown): void => {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-cache',
  });
  res.end(json);
};

const sendText = (res: http.ServerResponse, status: number, text: string): void => {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
};

const readJsonBody = (req: http.IncomingMessage, maxBytes: number): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();

        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });

const isExecRequestBody = (body: unknown): body is { bin: string; args: string[] } => {
  if (!body || typeof body !== 'object') return false;
  const b = body as { bin?: unknown; args?: unknown };

  return (
    typeof b.bin === 'string' && Array.isArray(b.args) && b.args.every((a) => typeof a === 'string')
  );
};

const streamFile = (res: http.ServerResponse, filePath: string): void => {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    sendText(res, 404, 'Not found');

    return;
  }
  res.writeHead(200, {
    'Content-Type': getMime(filePath),
    'Content-Length': size,
    'Cache-Control': 'no-cache',
  });
  createReadStream(filePath).pipe(res);
};

export interface LocalViewerServerOptions {
  /** Root directory containing `heal-traces/` (typically `process.cwd()`). */
  rootDir: string;
  /** Vendored SPA bundle directory (contains `index.html`). */
  bundleDir: string;
  port: number;
  /**
   * Optional: hostname to bind. Defaults to localhost only — never
   * 0.0.0.0; this is a single-user developer tool.
   */
  hostname?: string;
  log?: (msg: string) => void;
  /**
   * When true, serve only the `/api/*` routes and return 404 for
   * everything else — the vendored SPA bundle is not served. Lets an
   * external frontend (running on its own dev server) consume the REST
   * API cross-origin without this process also shipping a UI. CORS is
   * already wide-open, so no extra config is needed on the client.
   */
  apiOnly?: boolean;
  /**
   * When true, every spawned subprocess's stdout/stderr is mirrored to
   * the tracer's own stdout/stderr (in addition to being captured in
   * the per-job buffer that the HTTP API exposes). Useful for
   * debugging viewer-triggered `heal analyze` / `heal login` runs
   * without re-running the CLI by hand.
   */
  verbose?: boolean;
}

export class LocalViewerServer {
  private server: http.Server | null = null;
  private readonly options: LocalViewerServerOptions;
  // executionId → cached per-execution index; lazily populated.
  private readonly indexCacheByExec = new Map<string, IndexResponse>();
  private executionsCache: ExecutionSummary[] | null = null;
  private readonly execJobs: ExecJobManager;
  // Tracks the most recent `heal analyze` job per
  // `${executionId}/${playwrightTestId}/${attempt}` triple. Lets GET
  // report "running" before `analyze.ndjson` lands, and "failed
  // (crash)" if the file is half-written but the spawning process is
  // already gone.
  private readonly activeAnalyzeJobs = new Map<string, string>();

  constructor(options: LocalViewerServerOptions) {
    this.options = options;
    this.execJobs = new ExecJobManager(options.rootDir, { verbose: options.verbose });
  }

  async start(): Promise<void> {
    const { hostname = 'localhost', port } = this.options;
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err: Error) => {
        this.options.log?.(`[heal-tracer] handler error: ${err.message}`);
        if (!res.headersSent) {
          sendText(res, 500, 'Internal server error');
        } else {
          res.end();
        }
      });
    });

    return new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(port, hostname, () => resolve());
    });
  }

  /**
   * Port the server is actually listening on. Differs from
   * `options.port` when 0 was passed (OS-assigned ephemeral port —
   * the standard "let me pick" idiom). Returns null before `start()`
   * has finished or after `stop()`.
   */
  boundPort(): number | null {
    if (!this.server) return null;
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') return null;
    return addr.port;
  }

  stop(): Promise<void> {
    this.execJobs.shutdown();

    return new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();

        return;
      }
      this.server.close(() => resolve());
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    // Chrome Private Network Access: a public HTTPS origin (e.g.
    // trace.playwright.dev) fetching a private address (localhost)
    // requires this opt-in on the preflight response.
    res.setHeader('Access-Control-Allow-Private-Network', 'true');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();

      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    // POST is only valid for /api/exec; everything else is GET-only.
    if (pathname === '/api/exec' && req.method === 'POST') {
      await this.serveExecSpawn(req, res);

      return;
    }

    const execStatusMatch = /^\/api\/exec\/([0-9a-f-]+)$/.exec(pathname);
    if (execStatusMatch && req.method === 'GET') {
      this.serveExecStatus(res, execStatusMatch[1]);

      return;
    }

    const analyzeMatch = /^\/api\/executions\/([^/]+)\/tests\/([^/]+)\/(\d+)\/analyze$/.exec(
      pathname,
    );
    if (analyzeMatch) {
      if (req.method === 'POST') {
        this.serveAnalyzeStart(res, analyzeMatch[1], analyzeMatch[2], analyzeMatch[3]);

        return;
      }
      if (req.method === 'GET') {
        await this.serveAnalyzeStatus(res, analyzeMatch[1], analyzeMatch[2], analyzeMatch[3]);

        return;
      }
    }

    if (req.method !== 'GET') {
      sendText(res, 405, 'Method not allowed');

      return;
    }

    if (pathname === '/api/executions') {
      await this.serveExecutions(res);

      return;
    }

    const indexMatch = /^\/api\/executions\/([^/]+)\/index\.json$/.exec(pathname);
    if (indexMatch) {
      await this.serveIndex(res, indexMatch[1]);

      return;
    }

    const traceMatch = /^\/api\/executions\/([^/]+)\/tests\/([^/]+)\/(\d+)$/.exec(pathname);
    if (traceMatch) {
      await this.serveTrace(res, traceMatch[1], traceMatch[2], traceMatch[3]);

      return;
    }

    const screenshotMatch = /^\/api\/executions\/([^/]+)\/screenshot\/([^/]+)\/(\d+)\/(.+)$/.exec(
      pathname,
    );
    if (screenshotMatch) {
      await this.serveScreenshot(
        res,
        screenshotMatch[1],
        screenshotMatch[2],
        screenshotMatch[3],
        screenshotMatch[4],
      );

      return;
    }

    const assetMatch = /^\/api\/executions\/([^/]+)\/asset\/([^/]+)\/(\d+)\/(.+)$/.exec(pathname);
    if (assetMatch) {
      await this.serveAsset(res, assetMatch[1], assetMatch[2], assetMatch[3], assetMatch[4]);

      return;
    }

    if (this.options.apiOnly) {
      sendText(res, 404, 'Not found (api-only mode)');

      return;
    }

    await this.serveStatic(res, pathname);
  }

  private async serveExecSpawn(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readJsonBody(req, EXEC_BODY_MAX_BYTES);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid body';
      sendJson(res, 400, { error: message });

      return;
    }

    if (!isExecRequestBody(body)) {
      sendJson(res, 400, { error: 'Body must be { bin: string, args: string[] }' });

      return;
    }

    if (body.bin !== ALLOWED_EXEC_BIN) {
      sendJson(res, 403, {
        error: `Only '${ALLOWED_EXEC_BIN}' may be spawned via /api/exec.`,
      });

      return;
    }

    const jobId = this.execJobs.spawn(body.bin, body.args);
    const response: ExecSpawnResponse = { jobId };
    sendJson(res, 200, response);
  }

  private serveExecStatus(res: http.ServerResponse, jobId: string): void {
    const snapshot: ExecJobSnapshot | null = this.execJobs.get(jobId);
    if (!snapshot) {
      sendJson(res, 404, { error: 'Unknown jobId' } satisfies ApiErrorResponse);

      return;
    }
    sendJson(res, 200, snapshot);
  }

  private serveAnalyzeStart(
    res: http.ServerResponse,
    rawExecutionId: string,
    rawTestId: string,
    rawAttempt: string,
  ): void {
    if (!isSafeIdForRouting(rawExecutionId)) {
      sendJson(res, 400, { error: 'Bad executionId' } satisfies ApiErrorResponse);

      return;
    }
    if (!isSafeIdForRouting(rawTestId)) {
      sendJson(res, 400, { error: 'Bad playwrightTestId' } satisfies ApiErrorResponse);

      return;
    }
    const attempt = this.parseAttempt(rawAttempt);
    if (attempt === null) {
      sendJson(res, 400, { error: 'Bad attempt' } satisfies ApiErrorResponse);

      return;
    }

    // Re-run: truncate any prior `analyze.ndjson` BEFORE we spawn so the
    // next GET sees an empty file (paired with an active job → `running`)
    // instead of the previous run's terminal event. Without this, a
    // viewer polling the GET endpoint during the brief window between
    // POST returning and the CLI's first write would surface the old
    // verdict/error.
    const layout = new HealTracesLayout(this.options.rootDir, rawExecutionId);
    const priorNdjsonPath = layout.analyzeNdjsonPath(rawTestId, attempt);
    try {
      writeFileSync(priorNdjsonPath, '');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.options.log?.(
          `[heal-tracer] failed to truncate prior analyze.ndjson at ${priorNdjsonPath}: ${(err as Error).message}`,
        );
      }
      // ENOENT (parent dir missing) is fine — the CLI's publisher
      // creates the file on first event.
    }

    const compoundId = `${rawExecutionId}/${rawTestId}/${attempt}`;
    const jobId = this.execJobs.spawn('heal', ['analyze', '--test', compoundId, '--ndjson']);
    this.activeAnalyzeJobs.set(compoundId, jobId);

    const response: AnalyzeRunStartResponse = { jobId };
    sendJson(res, 200, response);
  }

  private async serveAnalyzeStatus(
    res: http.ServerResponse,
    rawExecutionId: string,
    rawTestId: string,
    rawAttempt: string,
  ): Promise<void> {
    if (!isSafeIdForRouting(rawExecutionId)) {
      sendJson(res, 400, { error: 'Bad executionId' } satisfies ApiErrorResponse);

      return;
    }
    if (!isSafeIdForRouting(rawTestId)) {
      sendJson(res, 400, { error: 'Bad playwrightTestId' } satisfies ApiErrorResponse);

      return;
    }
    const attempt = this.parseAttempt(rawAttempt);
    if (attempt === null) {
      sendJson(res, 400, { error: 'Bad attempt' } satisfies ApiErrorResponse);

      return;
    }

    const compoundId = `${rawExecutionId}/${rawTestId}/${attempt}`;
    const layout = new HealTracesLayout(this.options.rootDir, rawExecutionId);
    const ndjsonPath = layout.analyzeNdjsonPath(rawTestId, attempt);
    const content = await loadAnalyzeNdjson(ndjsonPath);
    const jobAlive = this.isAnalyzeJobAlive(compoundId);

    // No file yet.
    if (!content) {
      if (jobAlive) {
        const status: AnalyzeRunStatus = { status: 'running' };
        sendJson(res, 200, status);

        return;
      }
      sendJson(res, 404, { error: 'No analyze run for this test' } satisfies ApiErrorResponse);

      return;
    }

    // File present — let the terminal event (if any) drive the response,
    // falling back to the live job state otherwise.
    const terminal = content.terminal;
    if (terminal && terminal.event === 'verdict') {
      const status: AnalyzeRunStatus = {
        status: 'completed',
        verdict: terminal.verdict,
        events: content.events,
      };
      sendJson(res, 200, status);

      return;
    }
    if (terminal && terminal.event === 'error') {
      const status: AnalyzeRunStatus = {
        status: 'failed',
        message: terminal.message,
        events: content.events,
      };
      sendJson(res, 200, status);

      return;
    }

    // Non-terminal file (only `started` so far). Process either still
    // running, or crashed without finishing — distinguish via the
    // exec-job snapshot.
    if (jobAlive) {
      const status: AnalyzeRunStatus = { status: 'running' };
      sendJson(res, 200, status);

      return;
    }
    const status: AnalyzeRunStatus = {
      status: 'failed',
      message: 'analyze process exited without writing a terminal event',
      events: content.events,
    };
    sendJson(res, 200, status);
  }

  private isAnalyzeJobAlive(compoundId: string): boolean {
    const jobId = this.activeAnalyzeJobs.get(compoundId);
    if (!jobId) return false;
    const snap = this.execJobs.get(jobId);
    if (!snap) return false;
    return snap.status === 'running';
  }

  private async serveExecutions(res: http.ServerResponse): Promise<void> {
    if (!this.executionsCache) {
      this.executionsCache = await discoverExecutions(this.options.rootDir);
    }
    const response: ExecutionsResponse = { executions: this.executionsCache };
    sendJson(res, 200, response);
  }

  private async loadIndex(executionId: string): Promise<IndexResponse | null> {
    if (this.indexCacheByExec.has(executionId)) {
      return this.indexCacheByExec.get(executionId) ?? null;
    }
    const summaries = await discoverTraces(this.options.rootDir, executionId);
    if (summaries.length === 0) {
      // Don't cache empty results — the user may have just kicked off
      // a run and we'd hold onto a stale empty index forever.
      return null;
    }
    const index = buildIndex(executionId, summaries);
    this.indexCacheByExec.set(executionId, index);
    return index;
  }

  private async serveIndex(res: http.ServerResponse, executionId: string): Promise<void> {
    if (!isSafeIdForRouting(executionId)) {
      sendText(res, 400, 'Bad executionId');

      return;
    }
    const index = await this.loadIndex(executionId);
    if (!index) {
      sendJson(res, 200, buildIndex(executionId, []));

      return;
    }
    // Layer `hasAnalyzeVerdict` per-test fresh on each request — the
    // cached index from loadIndex deliberately holds it as `false`
    // because analyze status changes any time a verdict is written.
    // Reading analyze.ndjson per test is cheap (small files) and
    // avoids cache-invalidation coordination across spawn lifecycles.
    const layout = new HealTracesLayout(this.options.rootDir, executionId);
    const tests = await Promise.all(
      index.tests.map(async (t) => {
        const analyzePath = layout.analyzeNdjsonPath(t.playwrightTestId, t.attempt);
        const content = await loadAnalyzeNdjson(analyzePath);
        return {
          ...t,
          hasAnalyzeVerdict: content?.terminal?.event === 'verdict',
        };
      }),
    );
    sendJson(res, 200, { ...index, tests });
  }

  private findSummary(
    executionId: string,
    playwrightTestId: string,
    attempt: number,
  ): TestSummary | undefined {
    const index = this.indexCacheByExec.get(executionId);
    if (!index) return undefined;
    return index.tests.find(
      (t) => t.playwrightTestId === playwrightTestId && t.attempt === attempt,
    );
  }

  private parseAttempt(rawAttempt: string): number | null {
    if (!/^\d+$/.test(rawAttempt)) return null;
    const n = Number.parseInt(rawAttempt, 10);
    if (n <= 0) return null;
    return n;
  }

  private async serveTrace(
    res: http.ServerResponse,
    rawExecutionId: string,
    rawTestId: string,
    rawAttempt: string,
  ): Promise<void> {
    if (!isSafeIdForRouting(rawExecutionId)) {
      sendText(res, 400, 'Bad executionId');

      return;
    }
    if (!isSafeIdForRouting(rawTestId)) {
      sendText(res, 400, 'Bad playwrightTestId');

      return;
    }
    const attempt = this.parseAttempt(rawAttempt);
    if (attempt === null) {
      sendText(res, 400, 'Bad attempt');

      return;
    }

    await this.loadIndex(rawExecutionId);
    const summary = this.findSummary(rawExecutionId, rawTestId, attempt);
    if (!summary) {
      sendText(res, 404, 'Trace not found');

      return;
    }

    const layout = new HealTracesLayout(this.options.rootDir, rawExecutionId);
    const ndjsonAbs = layout.ndjsonPath(rawTestId, attempt);
    const trace = await loadTrace(ndjsonAbs);

    const baseScreenshotUrl = `/api/executions/${encodeURIComponent(rawExecutionId)}/screenshot/${encodeURIComponent(rawTestId)}/${attempt}`;
    const baseAssetUrl = `/api/executions/${encodeURIComponent(rawExecutionId)}/asset/${encodeURIComponent(rawTestId)}/${attempt}`;

    const rewritten = rewriteScreenshots(
      trace.statements,
      (filename) => `${baseScreenshotUrl}/${encodeURIComponent(filename)}`,
    );
    const encodePath = (relPath: string): string =>
      relPath
        .split(/[/\\]/)
        .map((segment) => encodeURIComponent(segment))
        .join('/');

    const attachments: AttachmentRef[] = summary.attachments.map((a) => ({
      url: `${baseAssetUrl}/${encodePath(a.path)}`,
      name: a.name,
      path: a.path,
      contentType: a.contentType,
    }));
    const response: TraceResponse = {
      header: trace.header,
      statements: rewritten,
      result: trace.result,
      attachments,
    };
    sendJson(res, 200, response);
  }

  private async serveAsset(
    res: http.ServerResponse,
    rawExecutionId: string,
    rawTestId: string,
    rawAttempt: string,
    rawFile: string,
  ): Promise<void> {
    if (!isSafeIdForRouting(rawExecutionId)) {
      sendText(res, 400, 'Bad executionId');

      return;
    }
    if (!isSafeIdForRouting(rawTestId)) {
      sendText(res, 400, 'Bad playwrightTestId');

      return;
    }
    const attempt = this.parseAttempt(rawAttempt);
    if (attempt === null) {
      sendText(res, 400, 'Bad attempt');

      return;
    }
    if (rawFile.includes('..') || path.isAbsolute(rawFile) || rawFile.includes('\\')) {
      sendText(res, 400, 'Bad filename');

      return;
    }

    const layout = new HealTracesLayout(this.options.rootDir, rawExecutionId);
    const testDir = layout.testDir(rawTestId, attempt);
    const filePath = path.resolve(path.join(testDir, rawFile));
    if (!filePath.startsWith(path.resolve(testDir) + path.sep)) {
      sendText(res, 400, 'Path traversal rejected');

      return;
    }
    try {
      await stat(filePath);
    } catch {
      sendText(res, 404, 'Not found');

      return;
    }
    streamFile(res, filePath);
  }

  private async serveScreenshot(
    res: http.ServerResponse,
    rawExecutionId: string,
    rawTestId: string,
    rawAttempt: string,
    rawFile: string,
  ): Promise<void> {
    if (!isSafeIdForRouting(rawExecutionId)) {
      sendText(res, 400, 'Bad executionId');

      return;
    }
    if (!isSafeIdForRouting(rawTestId)) {
      sendText(res, 400, 'Bad playwrightTestId');

      return;
    }
    const attempt = this.parseAttempt(rawAttempt);
    if (attempt === null) {
      sendText(res, 400, 'Bad attempt');

      return;
    }
    if (rawFile.includes('..') || path.isAbsolute(rawFile) || rawFile.includes('\\')) {
      sendText(res, 400, 'Bad filename');

      return;
    }

    const layout = new HealTracesLayout(this.options.rootDir, rawExecutionId);
    const filePath = path.resolve(layout.screenshotPath(rawTestId, attempt, rawFile));
    const screenshotsDir = path.dirname(layout.screenshotPath(rawTestId, attempt, 'x.png'));
    if (!filePath.startsWith(path.resolve(screenshotsDir) + path.sep)) {
      sendText(res, 400, 'Path traversal rejected');

      return;
    }
    try {
      await stat(filePath);
    } catch {
      sendText(res, 404, 'Not found');

      return;
    }
    streamFile(res, filePath);
  }

  private async serveStatic(res: http.ServerResponse, pathname: string): Promise<void> {
    const rel = pathname === '/' ? '/index.html' : pathname;
    if (rel.includes('..')) {
      sendText(res, 400, 'Path traversal rejected');

      return;
    }
    const filePath = path.resolve(path.join(this.options.bundleDir, rel));
    if (!filePath.startsWith(path.resolve(this.options.bundleDir) + path.sep)) {
      sendText(res, 400, 'Path traversal rejected');

      return;
    }
    // A missing path with a non-HTML extension must 404, not SPA-fallback to
    // index.html — otherwise the browser receives text/html for a request it
    // expected to be JS/CSS/etc. and rejects it (Strict MIME for module
    // scripts). Only extensionless paths (or .html) get the SPA fallback.
    const ext = path.extname(rel).toLowerCase();
    const isAssetPath = ext !== '' && ext !== '.html';
    try {
      const s = await stat(filePath);
      if (!s.isFile()) {
        if (isAssetPath) {
          sendText(res, 404, 'Not found');

          return;
        }
        streamFile(res, path.join(this.options.bundleDir, 'index.html'));

        return;
      }
    } catch {
      if (isAssetPath) {
        sendText(res, 404, 'Not found');

        return;
      }
      streamFile(res, path.join(this.options.bundleDir, 'index.html'));

      return;
    }
    streamFile(res, filePath);
  }
}
