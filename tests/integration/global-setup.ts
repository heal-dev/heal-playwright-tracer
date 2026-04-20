// Global setup for integration tests. Runs ONCE before any test in
// tests/integration/**. Responsible for:
//
//   1. Building the package (produces dist/).
//   2. `npm pack`-ing it into a tarball that simulates a real publish.
//   3. Creating a fresh tmp sandbox with a minimal Playwright project
//      that installs the tarball via a `file:` dependency.
//   4. Running `npm install` + `npx playwright install chromium` in
//      the sandbox.
//   5. Spinning up a tiny HTTP server that serves one static HTML
//      page with a button — the page the Playwright test will hit.
//
// The sandbox path and HTTP base URL are published to individual
// tests via `process.env.INTEGRATION_SANDBOX` / `INTEGRATION_BASE_URL`
// so they can be read from the vitest test bodies and forwarded to
// the spawned Playwright runner.
//
// Teardown closes the HTTP server. The tmp sandbox is left on disk
// deliberately — if an assertion fails it's useful to inspect what
// Playwright produced. The OS cleans /tmp eventually.

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
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

const SANDBOX_PLAYWRIGHT_CONFIG = `import { defineConfig } from '@playwright/test';

export default defineConfig({
  // The undocumented babel-plugin slot is what our tracer plugs into.
  '@playwright/test': {
    babelPlugins: [
      [require.resolve('@heal-dev/heal-playwright-tracer/code-hook-injector'), { include: [/\\/tests\\//] }],
    ],
  },
  testDir: './tests',
  reporter: 'line',
  use: {
    headless: true,
    screenshot: 'off',
    video: 'off',
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
} as any);
`;

// One spec, six scenarios — a single \`npx playwright test\` run exercises
// every branch the integration suite cares about. Each scenario is a
// distinct Playwright test so the fixture writes one statement-trace.json
// per scenario under its own test-results subdirectory.
const SANDBOX_SPEC = `import { test, expect, type Page } from '@playwright/test';

const base = process.env.INTEGRATION_BASE_URL as string;

async function clickHelloButton(page: Page) {
  const btn = page.locator('#hello');
  await btn.click();
}

test('happy path click', async ({ page }) => {
  await page.goto(base + '/');
  const button = page.locator('#hello');
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.locator('#status')).toHaveText('clicked');
});

test('failing assertion', async ({ page }) => {
  await page.goto(base + '/');
  expect(1 + 1).toBe(3);
});

test('test step nesting', async ({ page }) => {
  await page.goto(base + '/');
  await test.step('outer step', async () => {
    await test.step('inner step', async () => {
      await page.locator('#hello').click();
    });
  });
});

test('variable declarations', async ({ page }) => {
  await page.goto(base + '/');
  const greeting = 'hello world';
  const answer = 42;
  expect(greeting.length).toBeGreaterThan(0);
  expect(answer).toBe(42);
});

test('nested helper call', async ({ page }) => {
  await page.goto(base + '/');
  await clickHelloButton(page);
});

test('stdout and stderr capture', async ({ page }) => {
  console.log('hello from stdout');
  console.error('hello from stderr');
  await page.goto(base + '/');
});
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

  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-playwright-tracer-integration-'));
  console.log(`[integration] sandbox: ${sandboxRoot}`);

  fs.writeFileSync(
    path.join(sandboxRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'heal-playwright-tracer-integration-sandbox',
        version: '0.0.0',
        private: true,
        devDependencies: {
          '@playwright/test': '1.58.1',
          '@heal-dev/heal-playwright-tracer': `file:${tarballPath}`,
        },
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(path.join(sandboxRoot, 'playwright.config.ts'), SANDBOX_PLAYWRIGHT_CONFIG);
  fs.mkdirSync(path.join(sandboxRoot, 'tests'));
  fs.writeFileSync(path.join(sandboxRoot, 'tests', 'smoke.spec.ts'), SANDBOX_SPEC);

  console.log('[integration] npm install in sandbox…');
  run('npm install --no-audit --no-fund --silent', sandboxRoot);

  console.log('[integration] ensuring chromium is installed…');
  // No-op on machines that already have the browser cached.
  run('npx playwright install chromium', sandboxRoot);

  console.log('[integration] starting static HTTP server…');
  const { server, baseUrl } = await startHttpServer();
  console.log(`[integration] serving ${baseUrl}`);

  process.env.INTEGRATION_SANDBOX = sandboxRoot;
  process.env.INTEGRATION_BASE_URL = baseUrl;
  process.env.INTEGRATION_TARBALL = tarballPath;

  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
