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

import { createReadStream, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';

import { HealTracesLayout } from '../heal-traces-layout';

import {
  buildIndex,
  discoverExecutions,
  discoverTraces,
  isSafeIdForRouting,
  type ExecutionSummary,
  type TestSummary,
  type ViewerIndex,
} from './discover-traces';
import { loadTrace, rewriteScreenshots } from './ndjson-trace-loader';

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
}

export class LocalViewerServer {
  private server: http.Server | null = null;
  private readonly options: LocalViewerServerOptions;
  // executionId → cached per-execution index; lazily populated.
  private readonly indexCacheByExec = new Map<string, ViewerIndex>();
  private executionsCache: ExecutionSummary[] | null = null;

  constructor(options: LocalViewerServerOptions) {
    this.options = options;
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
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
    if (req.method !== 'GET') {
      sendText(res, 405, 'Method not allowed');

      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

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

    await this.serveStatic(res, pathname);
  }

  private async serveExecutions(res: http.ServerResponse): Promise<void> {
    if (!this.executionsCache) {
      this.executionsCache = await discoverExecutions(this.options.rootDir);
    }
    sendJson(res, 200, { executions: this.executionsCache });
  }

  private async loadIndex(executionId: string): Promise<ViewerIndex | null> {
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
    sendJson(res, 200, index);
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

    const attachments = summary.attachments.map((a) => ({
      url: `${baseAssetUrl}/${encodePath(a.path)}`,
      name: a.name,
      path: a.path,
      contentType: a.contentType,
    }));
    sendJson(res, 200, {
      header: trace.header,
      statements: rewritten,
      result: trace.result,
      attachments,
    });
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
    try {
      const s = await stat(filePath);
      if (!s.isFile()) {
        // SPA fallback: any deep path → index.html so client routing works.
        streamFile(res, path.join(this.options.bundleDir, 'index.html'));

        return;
      }
    } catch {
      streamFile(res, path.join(this.options.bundleDir, 'index.html'));

      return;
    }
    streamFile(res, filePath);
  }
}
