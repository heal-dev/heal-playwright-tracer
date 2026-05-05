/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Tiny Commander wrapper for the trace viewer. Mirrors the shape of
// heal-cli's CommanderCliAdapter but with a single subcommand
// (`view`). Lives in `src/application/...` to keep room for further
// commands later (e.g. `prune`, `export`).

import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { Command } from 'commander';

import { LocalViewerServer } from '../../infrastructure/local-viewer-adapter/local-viewer-server';

// Bind to port 0 — the OS picks a free ephemeral port. We then read
// the actual port back from the listening server's AddressInfo and
// use that for the printed URL and the browser-open. Avoids "port in
// use" failures when several copies of `heal-tracer view` overlap or
// when port 3000 is already taken by another dev server.
const RANDOM_PORT = 0;

export interface CommanderCliAdapterOptions {
  /** Override default `process.argv` parser. Used by tests. */
  argv?: string[];
  /** Bundle dir override. Defaults to the vendored assets dir. */
  bundleDir?: string;
  /** Logger. Defaults to console. */
  log?: (msg: string) => void;
  /** Override version string. Defaults to `package.json#version`. */
  version?: string;
}

const defaultBundleDir = (): string =>
  // Resolves to <package-root>/tracer-viewer-bundle. At runtime,
  // __dirname is `<package-root>/dist/application/commander-cli-adapter`
  // — both during local dev and when the package is installed under
  // `node_modules/@heal-dev/heal-playwright-tracer/`. Walking three
  // levels up lands at the package root, where the committed bundle
  // lives. In tests, the caller passes `bundleDir` explicitly.
  path.resolve(__dirname, '..', '..', '..', 'tracer-viewer-bundle');

const openInBrowser = (url: string): void => {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${cmd} ${JSON.stringify(url)}`);
};

export class CommanderCliAdapter {
  private readonly program: Command;
  private readonly options: CommanderCliAdapterOptions;

  constructor(options: CommanderCliAdapterOptions = {}) {
    this.options = options;
    this.program = new Command();
    this.initialize();
  }

  private initialize(): void {
    this.program
      .name('heal-tracer')
      .description('Local viewer for heal-playwright-tracer artefacts')
      .version(this.options.version ?? '0.0.0', '-v, --version', 'Show version')
      .helpOption('-h, --help', 'Show this help');

    this.program
      .command('view')
      .description('Serve the local trace viewer over an http server')
      .action(async () => {
        await this.handleView();
      });
  }

  private log(msg: string): void {
    (this.options.log ?? console.log.bind(console))(msg);
  }

  private async handleView(): Promise<void> {
    const rootDir = process.cwd();

    const bundleDir = this.options.bundleDir ?? defaultBundleDir();
    if (!existsSync(path.join(bundleDir, 'index.html'))) {
      console.error(
        `[heal-tracer] viewer bundle not found at ${bundleDir}.\n` +
          `Reinstall @heal-dev/heal-playwright-tracer.`,
      );
      process.exit(1);
    }

    const server = new LocalViewerServer({
      rootDir,
      bundleDir,
      port: RANDOM_PORT,
      log: (m) => this.log(m),
    });

    await server.start();
    const port = server.boundPort();
    if (port === null) {
      console.error('[heal-tracer] server failed to bind a port');
      process.exit(1);
    }
    const url = `http://localhost:${String(port)}`;
    this.log(`✓ heal-tracer viewer running at ${url}`);
    this.log(`  scanning: ${rootDir} (recursive)`);

    openInBrowser(url);

    this.log('Press Ctrl+C to stop.');

    await new Promise<void>((resolve) => {
      const shutdown = () => {
        this.log('\nStopping viewer…');
        server
          .stop()
          .catch(() => undefined)
          .finally(() => resolve());
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });

    process.exit(0);
  }

  async parse(argv?: string[]): Promise<void> {
    await this.program.parseAsync(argv ?? this.options.argv ?? process.argv);
  }
}
