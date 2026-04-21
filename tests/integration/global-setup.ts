/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 */
// Global setup for integration tests. Runs ONCE before any test in
// tests/integration/**.
//
// Responsibilities:
//   1. `npm run build` — produces dist/.
//   2. `npm pack` — produces the tarball each sandbox installs from
//      via a `file:` dependency.
//   3. Spin up a tiny HTTP server that serves one static HTML page
//      with a button — the page the Playwright scenarios click.
//
// Per-test-file sandbox creation has moved into `IntegrationSandbox`
// so each test file (`scenarios-disk.test.ts`, `scenarios-http.test.ts`)
// owns its own tmp dir and doesn't share state with siblings.
//
// Teardown closes the HTTP server. Sandboxes are deliberately left on
// disk for post-mortem inspection — the OS cleans /tmp eventually.

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import type { AddressInfo } from 'net';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const SANDBOX_HTML = `<!doctype html>
<html>
  <body>
    <h1>integration test page</h1>
    <button id="hello">click me</button>
    <p id="status">idle</p>
    <script>
      document.getElementById('hello').addEventListener('click', () => {
        document.getElementById('status').textContent = 'clicked';
      });
    </script>
  </body>
</html>
`;

function run(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: 'inherit' });
}

function runQuiet(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'inherit'] })
    .toString()
    .trim();
}

function startHttpServer(): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(SANDBOX_HTML);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  console.log('[integration] building heal-playwright-tracer…');
  run('npm run build', REPO_ROOT);

  console.log('[integration] packing tarball…');
  const tarballName = runQuiet('npm pack --silent', REPO_ROOT);
  const tarballPath = path.resolve(REPO_ROOT, tarballName);
  if (!fs.existsSync(tarballPath)) {
    throw new Error(`[integration] tarball not found at ${tarballPath}`);
  }

  console.log('[integration] starting static HTTP server…');
  const { server, baseUrl } = await startHttpServer();
  console.log(`[integration] serving ${baseUrl}`);

  process.env.INTEGRATION_TARBALL = tarballPath;
  process.env.INTEGRATION_BASE_URL = baseUrl;

  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
