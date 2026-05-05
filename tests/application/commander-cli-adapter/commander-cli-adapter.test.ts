/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// Avoid actually launching a browser when the CLI calls exec(open|xdg-open|start).
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, exec: vi.fn() };
});

import { CommanderCliAdapter } from '../../../src/application/commander-cli-adapter/commander-cli-adapter';

class ExitCalled extends Error {
  constructor(public code: number) {
    super(`process.exit(${String(code)})`);
  }
}

const ignoreExit = (e: unknown): void => {
  if (!(e instanceof ExitCalled)) throw e;
};

let originalExit: typeof process.exit;
let exitCodes: number[];

beforeEach(() => {
  originalExit = process.exit;
  exitCodes = [];
  process.exit = ((code?: number) => {
    exitCodes.push(code ?? 0);
    throw new ExitCalled(code ?? 0);
  }) as unknown as typeof process.exit;
});

afterEach(() => {
  process.exit = originalExit;
});

describe('CommanderCliAdapter — view subcommand', () => {
  let tmpRoot: string;
  let bundleDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'heal-cli-adapter-'));
    bundleDir = path.join(tmpRoot, 'bundle');
    originalCwd = process.cwd();
    process.chdir(tmpRoot);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('exits with code 1 when the bundle dir lacks index.html', async () => {
    await mkdir(bundleDir, { recursive: true });
    const errs: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errs.push(args.map((a) => String(a)).join(' '));
    });

    const adapter = new CommanderCliAdapter({
      argv: ['node', 'heal-tracer', 'view'],
      bundleDir,
    });
    await adapter.parse().catch(ignoreExit);

    errSpy.mockRestore();
    expect(exitCodes).toContain(1);
    expect(errs.join('\n')).toContain('viewer bundle not found');
  });

  it('starts the server on a random port and prints the URL, then exits 0 on SIGINT', async () => {
    await mkdir(bundleDir, { recursive: true });
    await writeFile(path.join(bundleDir, 'index.html'), '<!doctype html>SPA');

    const logs: string[] = [];
    const sigintBefore = new Set(process.listeners('SIGINT'));

    const adapter = new CommanderCliAdapter({
      argv: ['node', 'heal-tracer', 'view'],
      bundleDir,
      log: (m) => logs.push(m),
    });
    const parsePromise = adapter.parse().catch(ignoreExit);

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !logs.some((l) => l.includes('running at http://localhost:'))) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const urlLine = logs.find((l) => l.includes('running at http://localhost:'));
    expect(urlLine).toBeDefined();
    // OS-assigned ephemeral port — non-zero, well above the privileged range.
    const portMatch = /http:\/\/localhost:(\d+)/.exec(urlLine!);
    expect(portMatch).not.toBeNull();
    const port = Number(portMatch![1]);
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(logs.some((l) => l.includes('scanning:'))).toBe(true);
    expect(logs.some((l) => l.includes('Press Ctrl+C'))).toBe(true);

    // Invoke our SIGINT listener directly to avoid disturbing the test
    // runner's own signal handling.
    const ourSigint = process.listeners('SIGINT').find((l) => !sigintBefore.has(l));
    expect(ourSigint).toBeDefined();
    (ourSigint as (sig: NodeJS.Signals) => void)('SIGINT');

    await parsePromise;
    expect(exitCodes).toContain(0);
    expect(logs.some((l) => l.includes('Stopping viewer'))).toBe(true);
  });
});
