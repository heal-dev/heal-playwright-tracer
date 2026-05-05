/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Local-only HTTP server for the trace viewer. Two responsibilities:
//   1. Serve the static SPA bundle vendored under
//      `dist/infrastructure/local-viewer-adapter/trace-viewer-assets/`.
//   2. Expose `/api/index.json`, `/api/trace/:id`, and
//      `/api/screenshot/:id/:file` over the user's `test-results/`
//      directory.
//
// No third-party deps — Node's built-in `http` is enough. The SPA
// is the trust boundary: every URL parameter is run through the
// path-traversal guard before we touch the filesystem.

import { createReadStream, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';

import { HealDataLayout } from '../heal-data-layout/heal-data-layout';

import {
  buildIndex,
  discoverTraces,
  isSafeIdForRouting,
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
  /** Playwright `test-results/` (or whatever the user passed). */
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
  private indexCache: ViewerIndex | null = null;

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
    // requires this opt-in on the preflight response. Without it
    // the preflight fails before the GET is attempted, regardless
    // of any LNA user-permission grant.
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

    if (pathname === '/api/index.json') {
      await this.serveIndex(res);

      return;
    }

    const traceMatch = /^\/api\/trace\/([^/]+)$/.exec(pathname);
    if (traceMatch) {
      await this.serveTrace(res, traceMatch[1]);

      return;
    }

    const screenshotMatch = /^\/api\/screenshot\/([^/]+)\/(.+)$/.exec(pathname);
    if (screenshotMatch) {
      await this.serveScreenshot(res, screenshotMatch[1], screenshotMatch[2]);

      return;
    }

    const videoMatch = /^\/api\/video\/([^/]+)\/(.+)$/.exec(pathname);
    if (videoMatch) {
      await this.serveAsset(res, videoMatch[1], videoMatch[2]);

      return;
    }

    const assetMatch = /^\/api\/asset\/([^/]+)\/(.+)$/.exec(pathname);
    if (assetMatch) {
      await this.serveAsset(res, assetMatch[1], assetMatch[2]);

      return;
    }

    await this.serveStatic(res, pathname);
  }

  private async loadIndex(): Promise<ViewerIndex> {
    if (this.indexCache) {
      return this.indexCache;
    }
    const summaries = await discoverTraces(this.options.rootDir);
    this.indexCache = buildIndex(summaries);

    return this.indexCache;
  }

  private async serveIndex(res: http.ServerResponse): Promise<void> {
    const index = await this.loadIndex();
    sendJson(res, 200, index);
  }

  private findSummary(id: string): TestSummary | undefined {
    return this.indexCache?.tests.find((t) => t.id === id);
  }

  private async serveTrace(res: http.ServerResponse, rawId: string): Promise<void> {
    if (!isSafeIdForRouting(rawId)) {
      sendText(res, 400, 'Bad id');

      return;
    }
    await this.loadIndex();
    const summary = this.findSummary(rawId);
    if (!summary) {
      sendText(res, 404, 'Trace not found');

      return;
    }
    const ndjsonAbs = path.join(this.options.rootDir, summary.ndjsonPath);
    const trace = await loadTrace(ndjsonAbs);
    const rewritten = rewriteScreenshots(
      trace.statements,
      (filename) => `/api/screenshot/${encodeURIComponent(rawId)}/${encodeURIComponent(filename)}`,
    );
    const encodePath = (relPath: string): string =>
      relPath
        .split(/[/\\]/)
        .map((segment) => encodeURIComponent(segment))
        .join('/');

    const videos = summary.videos.map((v) => ({
      url: `/api/asset/${encodeURIComponent(rawId)}/${encodePath(v.file)}`,
      label: v.label,
    }));
    const attachments = summary.attachments.map((a) => ({
      url: `/api/asset/${encodeURIComponent(rawId)}/${encodePath(a.path)}`,
      name: a.name,
      path: a.path,
      contentType: a.contentType,
    }));
    sendJson(res, 200, {
      header: trace.header,
      statements: rewritten,
      result: trace.result,
      videos,
      attachments,
    });
  }

  /**
   * Serve any file inside a test's outputDir (the parent of
   * `heal-data/`). Backs `/api/video/:id/:file` (kept for
   * backwards-compat) and `/api/asset/:id/:file` (the canonical
   * route). Same id-scoped, traversal-guarded resolution either way.
   */
  private async serveAsset(
    res: http.ServerResponse,
    rawId: string,
    rawFile: string,
  ): Promise<void> {
    if (!isSafeIdForRouting(rawId)) {
      sendText(res, 400, 'Bad id');

      return;
    }
    if (rawFile.includes('..') || path.isAbsolute(rawFile) || rawFile.includes('\\')) {
      sendText(res, 400, 'Bad filename');

      return;
    }
    await this.loadIndex();
    const summary = this.findSummary(rawId);
    if (!summary) {
      sendText(res, 404, 'Trace not found');

      return;
    }
    const testDir = path.dirname(path.dirname(path.join(this.options.rootDir, summary.ndjsonPath)));
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
    rawId: string,
    rawFile: string,
  ): Promise<void> {
    if (!isSafeIdForRouting(rawId)) {
      sendText(res, 400, 'Bad id');

      return;
    }
    if (rawFile.includes('..') || path.isAbsolute(rawFile) || rawFile.includes('\\')) {
      sendText(res, 400, 'Bad filename');

      return;
    }
    await this.loadIndex();
    const summary = this.findSummary(rawId);
    if (!summary) {
      sendText(res, 404, 'Trace not found');

      return;
    }
    const healDataDir = path.dirname(path.join(this.options.rootDir, summary.ndjsonPath));
    const filePath = path.resolve(path.join(healDataDir, rawFile));
    // Containment guard: resolved path must stay inside heal-data dir.
    if (!filePath.startsWith(path.resolve(healDataDir) + path.sep)) {
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

// Re-export the layout helper so callers can stat heal-data dirs the
// same way the writer does.
export { HealDataLayout };
