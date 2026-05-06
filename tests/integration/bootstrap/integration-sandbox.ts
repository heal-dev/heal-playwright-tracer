/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Builds and drives a one-shot Playwright sandbox for the integration suite.
//
// Each test file owns its own sandbox: a fresh tmp dir holding a
// `package.json` that depends on the tracer tarball produced by
// global-setup, a minimal `playwright.config.ts`, and one spec.
//
// `withStubExporter: true` writes `heal-stub-exporter.ts` next to the
// config and amends the config to register it via `configureTracer`,
// so the test exercises the user-extension surface end-to-end. The
// default NDJSON exporter stays wired alongside it.
//
// `runPlaywright` tolerates exit code 1 because one of the six
// scenarios is intentionally a failing assertion. Anything else is
// re-thrown with stdout/stderr surfaced for debugging.

import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { STUB_EXPORTER_SOURCE } from './test-doubles/stub-exporter-source';
import { PREPROCESS_SOURCE } from './test-doubles/preprocess-source';

export interface SandboxOptions {
  /** Absolute path to the `@heal-dev/heal-playwright-tracer` tarball produced by global-setup. */
  tarballPath: string;
  /** Source for `tests/spec.ts`. Typically `SCENARIO_SPEC` from `./scenario-spec`. */
  specSource: string;
  /**
   * When true, scaffold a `heal-stub-exporter.ts` module next to
   * `playwright.config.ts` and register it via `configureTracer`.
   * The exporter POSTs each test's records as ndjson to
   * `process.env.STUB_COLLECTOR_URL` on close.
   */
  withStubExporter?: boolean;
  /**
   * When true, omit the heal reporter from the generated config — used
   * by the negative-path test that asserts the fixture fails fast when
   * the Babel plugin is wired without the reporter. All other tests
   * leave this unset; the reporter is part of the default config.
   */
  withoutHealReporter?: boolean;
  /**
   * When true, scaffold a `heal-preprocess.ts` module next to
   * `playwright.config.ts` and register its export via
   * `configureTracer({ preProcessors: [...] })`. The preprocessor
   * scans `meta.source` for `marker:<word>` and appends a JSON line
   * to `<ctx.healDataDir>/preprocess-record.ndjson` on each hit.
   */
  withPreProcessor?: boolean;
}

export class IntegrationSandbox {
  private root: string | null = null;

  constructor(private readonly opts: SandboxOptions) {}

  /** Create the tmp dir and write all files. Returns the sandbox root. */
  scaffold(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-playwright-tracer-it-'));
    this.root = root;

    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify(
        {
          name: 'heal-playwright-tracer-integration-sandbox',
          version: '0.0.0',
          private: true,
          devDependencies: {
            '@playwright/test': process.env.PLAYWRIGHT_VERSION ?? '1.58.1',
            '@heal-dev/heal-playwright-tracer': `file:${this.opts.tarballPath}`,
          },
        },
        null,
        2,
      ),
    );

    fs.writeFileSync(path.join(root, 'playwright.config.ts'), this.buildConfig());

    if (this.opts.withStubExporter) {
      fs.writeFileSync(path.join(root, 'heal-stub-exporter.ts'), STUB_EXPORTER_SOURCE);
    }

    if (this.opts.withPreProcessor) {
      fs.writeFileSync(path.join(root, 'heal-preprocess.ts'), PREPROCESS_SOURCE);
    }

    fs.mkdirSync(path.join(root, 'tests'));
    fs.writeFileSync(path.join(root, 'tests', 'scenarios.spec.ts'), this.opts.specSource);

    return root;
  }

  /** Run `npm install` + `npx playwright install chromium` in the sandbox. */
  install(): void {
    const cwd = this.requireRoot();
    execSync('npm install --no-audit --no-fund --silent', { cwd, stdio: 'inherit' });
    // No-op when chromium is already cached.
    execSync('npx playwright install chromium', { cwd, stdio: 'inherit' });
  }

  /**
   * Run `npx playwright test`. Tolerates exit code 1 (one scenario is
   * intentionally a failing assertion).
   *
   * Uses async `spawn` (not `execSync`) so the parent event loop
   * stays free during the run — critical when the parent also runs
   * a `StubCollectorServer` that needs to accept POSTs from the
   * Playwright worker. `execSync` would block the loop and the
   * server would never respond, hanging every test in `close()`.
   */
  async runPlaywright(extraEnv: Record<string, string> = {}): Promise<void> {
    const cwd = this.requireRoot();
    await new Promise<void>((resolve, reject) => {
      const child = spawn('npx', ['playwright', 'test'], {
        cwd,
        env: { ...process.env, ...extraEnv },
        stdio: 'inherit',
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0 || code === 1) resolve();
        else reject(new Error(`playwright exited with code ${code}`));
      });
    });
  }

  /**
   * Variant of `runPlaywright` that captures stdout/stderr instead of
   * inheriting the parent's. Used by the negative-path test that
   * asserts on the diagnostic message printed when the reporter is
   * missing. Tolerates any non-zero exit code — the caller decides
   * whether failure was expected.
   */
  async runPlaywrightCapturing(
    extraEnv: Record<string, string> = {},
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const cwd = this.requireRoot();
    return new Promise((resolve, reject) => {
      const child = spawn('npx', ['playwright', 'test'], {
        cwd,
        env: { ...process.env, ...extraEnv },
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (c) => (stdout += c.toString('utf8')));
      child.stderr?.on('data', (c) => (stderr += c.toString('utf8')));
      child.on('error', reject);
      child.on('exit', (code) => resolve({ code, stdout, stderr }));
    });
  }

  /** Absolute path to the sandbox root. Throws if `scaffold()` hasn't run. */
  getRoot(): string {
    return this.requireRoot();
  }

  private requireRoot(): string {
    if (!this.root) throw new Error('IntegrationSandbox: call scaffold() first.');
    return this.root;
  }

  private buildConfig(): string {
    // Build the import + configureTracer block from whichever
    // extensions were requested. Stub exporter and pre-processor are
    // independent — both can be enabled, neither is, or one of each.
    const importLines: string[] = [`import { defineConfig } from '@playwright/test';`];
    const tracerOpts: string[] = [];
    if (this.opts.withStubExporter || this.opts.withPreProcessor) {
      importLines.push(`import { configureTracer } from '@heal-dev/heal-playwright-tracer';`);
    }
    if (this.opts.withStubExporter) {
      importLines.push(`import { stubExporterFactory } from './heal-stub-exporter';`);
      tracerOpts.push(`exporters: [stubExporterFactory]`);
    }
    if (this.opts.withPreProcessor) {
      importLines.push(`import { recordingPreProcessor } from './heal-preprocess';`);
      tracerOpts.push(`preProcessors: [recordingPreProcessor]`);
    }
    const head =
      tracerOpts.length === 0
        ? importLines.join('\n') + '\n'
        : `${importLines.join('\n')}

configureTracer({ ${tracerOpts.join(', ')} });
`;

    const reporter = this.opts.withoutHealReporter
      ? `'line'`
      : `[['line'], ['@heal-dev/heal-playwright-tracer/reporter']]`;

    return `${head}
export default defineConfig({
  // The undocumented babel-plugin slot is what our tracer plugs into.
  '@playwright/test': {
    babelPlugins: [
      [require.resolve('@heal-dev/heal-playwright-tracer/code-hook-injector'), { include: [/\\/tests\\//] }],
    ],
  },
  testDir: './tests',
  reporter: ${reporter},
  use: {
    headless: true,
    screenshot: 'off',
    video: 'off',
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
} as any);
`;
  }
}
