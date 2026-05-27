/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { ExecJobManager } from '../../../src/infrastructure/local-viewer-adapter/exec-job-manager';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function waitForExit(
  manager: ExecJobManager,
  jobId: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = manager.get(jobId);
    if (snap && snap.status === 'exited') return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`job ${jobId} did not exit within ${timeoutMs}ms`);
}

async function makeTmpRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), 'heal-tracer-exec-job-'));
}

describe('ExecJobManager', () => {
  it('spawn returns a UUID and creates a queryable job', async () => {
    const root = await makeTmpRoot();
    const manager = new ExecJobManager(root);
    const jobId = manager.spawn(process.execPath, ['-e', '']);
    expect(jobId).toMatch(UUID_RE);
    const snap = manager.get(jobId);
    expect(snap).not.toBeNull();
    expect(snap?.jobId).toBe(jobId);
    expect(['running', 'exited']).toContain(snap?.status);
    await waitForExit(manager, jobId);
  });

  it('get for unknown id returns null', async () => {
    const root = await makeTmpRoot();
    const manager = new ExecJobManager(root);
    expect(manager.get('not-a-real-job-id')).toBeNull();
    expect(manager.get(randomUUID())).toBeNull();
  });

  it('buffers stdout line-by-line, strips CR, joins partial chunks', async () => {
    const root = await makeTmpRoot();
    const manager = new ExecJobManager(root);
    const script =
      'process.stdout.write("alpha\\nbeta\\r\\ngamma"); setTimeout(() => process.stdout.write(" delta\\n"), 10);';
    const jobId = manager.spawn(process.execPath, ['-e', script]);
    await waitForExit(manager, jobId);
    const snap = manager.get(jobId);
    expect(snap?.stdout).toEqual(['alpha', 'beta', 'gamma delta']);
  });

  it('buffers stderr line-by-line, strips CR, joins partial chunks', async () => {
    const root = await makeTmpRoot();
    const manager = new ExecJobManager(root);
    const script =
      'process.stderr.write("alpha\\nbeta\\r\\ngamma"); setTimeout(() => process.stderr.write(" delta\\n"), 10);';
    const jobId = manager.spawn(process.execPath, ['-e', script]);
    await waitForExit(manager, jobId);
    const snap = manager.get(jobId);
    expect(snap?.stderr).toEqual(['alpha', 'beta', 'gamma delta']);
  });

  it('flushes trailing partial line (no newline) on exit', async () => {
    const root = await makeTmpRoot();
    const manager = new ExecJobManager(root);
    const jobId = manager.spawn(process.execPath, ['-e', 'process.stdout.write("no-newline");']);
    await waitForExit(manager, jobId);
    const snap = manager.get(jobId);
    expect(snap?.stdout).toEqual(['no-newline']);
  });

  it('captures ENOENT (missing binary) as [exec error] in stderr', async () => {
    const root = await makeTmpRoot();
    const manager = new ExecJobManager(root);
    const bogus = `definitely-not-a-binary-${randomUUID()}`;
    const jobId = manager.spawn(bogus, []);
    await waitForExit(manager, jobId);
    const snap = manager.get(jobId);
    expect(snap?.status).toBe('exited');
    expect(snap?.exitCode).toBe(1);
    expect(snap?.stderr.some((line) => line.startsWith('[exec error]'))).toBe(true);
  });

  it('captures non-zero exit code', async () => {
    const root = await makeTmpRoot();
    const manager = new ExecJobManager(root);
    const jobId = manager.spawn(process.execPath, ['-e', 'process.exit(7)']);
    await waitForExit(manager, jobId);
    const snap = manager.get(jobId);
    expect(snap?.status).toBe('exited');
    expect(snap?.exitCode).toBe(7);
  });

  it('captures zero exit code', async () => {
    const root = await makeTmpRoot();
    const manager = new ExecJobManager(root);
    const jobId = manager.spawn(process.execPath, ['-e', '']);
    await waitForExit(manager, jobId);
    const snap = manager.get(jobId);
    expect(snap?.status).toBe('exited');
    expect(snap?.exitCode).toBe(0);
  });

  it('prepends <rootDir>/node_modules/.bin to PATH', async () => {
    if (process.platform === 'win32') return;
    const root = await makeTmpRoot();
    const binDir = path.join(root, 'node_modules', '.bin');
    await mkdir(binDir, { recursive: true });
    const sentinel = `sentinel-${randomUUID()}`;
    const binPath = path.join(binDir, 'dummy-bin');
    await writeFile(binPath, `#!/bin/sh\necho "${sentinel}"\n`, 'utf-8');
    await chmod(binPath, 0o755);

    const manager = new ExecJobManager(root);
    const jobId = manager.spawn('dummy-bin', []);
    await waitForExit(manager, jobId);
    const snap = manager.get(jobId);
    expect(snap?.status).toBe('exited');
    expect(snap?.exitCode).toBe(0);
    expect(snap?.stdout).toContain(sentinel);
  });

  it('shutdown SIGTERMs running jobs', async () => {
    const root = await makeTmpRoot();
    const manager = new ExecJobManager(root);
    const jobId = manager.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);']);
    // Confirm it's actually running before we kill it.
    const before = manager.get(jobId);
    expect(before?.status).toBe('running');

    manager.shutdown();
    await waitForExit(manager, jobId);
    const snap = manager.get(jobId);
    expect(snap?.status).toBe('exited');
    // On POSIX, a child killed by SIGTERM exits with a null code (the
    // process was signaled rather than calling exit()). Node reports
    // this as `code === null` in the 'exit' handler.
    expect(snap?.exitCode).toBeNull();
  });

  describe('verbose echo', () => {
    it('mirrors stdout lines to process.stdout with a [bin jobIdShort] prefix when verbose=true', async () => {
      const root = await makeTmpRoot();
      const captured: string[] = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
        captured.push(String(chunk));
        return true;
      }) as unknown as typeof process.stdout.write);
      try {
        const manager = new ExecJobManager(root, { verbose: true });
        const jobId = manager.spawn(process.execPath, [
          '-e',
          'process.stdout.write("hello-stdout\\n")',
        ]);
        await waitForExit(manager, jobId);
        const echoed = captured.find((s) => s.includes('hello-stdout'));
        expect(echoed).toBeDefined();
        // Prefix shape: `[<bin> <first-8-of-jobId>] <line>`
        expect(echoed).toMatch(/^\[\S+ [0-9a-f]{8}\] hello-stdout\n$/);
      } finally {
        spy.mockRestore();
      }
    });

    it('mirrors stderr lines to process.stderr when verbose=true', async () => {
      const root = await makeTmpRoot();
      const captured: string[] = [];
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
        captured.push(String(chunk));
        return true;
      }) as unknown as typeof process.stderr.write);
      try {
        const manager = new ExecJobManager(root, { verbose: true });
        const jobId = manager.spawn(process.execPath, ['-e', 'process.stderr.write("oops\\n")']);
        await waitForExit(manager, jobId);
        const echoed = captured.find((s) => s.includes('oops'));
        expect(echoed).toBeDefined();
        expect(echoed).toMatch(/^\[\S+ [0-9a-f]{8}\] oops\n$/);
      } finally {
        spy.mockRestore();
      }
    });

    it('does NOT echo when verbose is off (default)', async () => {
      const root = await makeTmpRoot();
      const captured: string[] = [];
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
        captured.push(String(chunk));
        return true;
      }) as unknown as typeof process.stdout.write);
      try {
        const manager = new ExecJobManager(root);
        const jobId = manager.spawn(process.execPath, [
          '-e',
          'process.stdout.write("should-not-echo\\n")',
        ]);
        await waitForExit(manager, jobId);
        // The line was captured by the manager's buffer but never
        // forwarded to process.stdout.
        expect(captured.find((s) => s.includes('should-not-echo'))).toBeUndefined();
        // Sanity: the line IS in the snapshot.
        expect(manager.get(jobId)?.stdout).toContain('should-not-echo');
      } finally {
        stdoutSpy.mockRestore();
      }
    });
  });
});
