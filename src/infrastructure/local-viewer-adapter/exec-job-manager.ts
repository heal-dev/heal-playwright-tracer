/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// In-memory registry of child processes spawned via POST /api/exec.
// Each job buffers its own stdout/stderr line-by-line so the SPA can
// poll `GET /api/exec/:jobId` for a snapshot. Jobs outlive the
// originating HTTP request — that's the whole point: the viewer can
// kick off `heal login`, navigate the same tab to the auth URL, and
// come back later to find the process either still waiting on the
// browser callback or already finished.
//
// The bin allowlist is enforced one layer up (in LocalViewerServer)
// so this module stays purely mechanical.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

export type ExecJobStatus = 'running' | 'exited';

export interface ExecJobSnapshot {
  jobId: string;
  status: ExecJobStatus;
  exitCode: number | null;
  stdout: string[];
  stderr: string[];
}

interface ExecJob {
  process: ChildProcess;
  status: ExecJobStatus;
  exitCode: number | null;
  stdoutBuf: string;
  stderrBuf: string;
  stdoutLines: string[];
  stderrLines: string[];
}

export interface ExecJobManagerOptions {
  /**
   * When true, every captured stdout/stderr line is also echoed to the
   * tracer's own stdout/stderr (with a `[<bin> <jobId-short>]` prefix)
   * so the user can follow what the spawned process is doing without
   * polling the snapshot endpoint. Off by default — the viewer's HTTP
   * API is the canonical surface.
   */
  verbose?: boolean;
}

export class ExecJobManager {
  private readonly jobs = new Map<string, ExecJob>();
  private readonly rootDir: string;
  private readonly verbose: boolean;

  constructor(rootDir: string, options: ExecJobManagerOptions = {}) {
    this.rootDir = rootDir;
    this.verbose = options.verbose ?? false;
  }

  spawn(bin: string, args: string[]): string {
    const jobId = randomUUID();
    // Mirror npx's lookup behaviour: prepend the local node_modules/.bin
    // so `heal` resolves whether it was installed locally or globally.
    const localBin = path.join(this.rootDir, 'node_modules', '.bin');
    const env = {
      ...process.env,
      PATH: `${localBin}${path.delimiter}${process.env.PATH ?? ''}`,
    };
    const child = spawn(bin, args, {
      cwd: this.rootDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const job: ExecJob = {
      process: child,
      status: 'running',
      exitCode: null,
      stdoutBuf: '',
      stderrBuf: '',
      stdoutLines: [],
      stderrLines: [],
    };
    this.jobs.set(jobId, job);

    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');

    const prefix = this.verbose ? `[${bin} ${jobId.slice(0, 8)}]` : null;
    const echoLine = (stream: 'stdout' | 'stderr', line: string): void => {
      if (!prefix) return;
      const out = stream === 'stdout' ? process.stdout : process.stderr;
      out.write(`${prefix} ${line}\n`);
    };

    child.stdout?.on('data', (chunk: string) => {
      const before = job.stdoutLines.length;
      job.stdoutBuf = drainLines(job.stdoutBuf + chunk, job.stdoutLines);
      for (let i = before; i < job.stdoutLines.length; i++) echoLine('stdout', job.stdoutLines[i]);
    });
    child.stderr?.on('data', (chunk: string) => {
      const before = job.stderrLines.length;
      job.stderrBuf = drainLines(job.stderrBuf + chunk, job.stderrLines);
      for (let i = before; i < job.stderrLines.length; i++) echoLine('stderr', job.stderrLines[i]);
    });
    child.on('error', (err: Error) => {
      // ENOENT lands here, before 'exit'. Capture it as stderr so the
      // viewer can recognise "bin not installed" without a separate
      // probe endpoint.
      job.stderrLines.push(`[exec error] ${err.message}`);
      job.status = 'exited';
      job.exitCode = 1;
    });
    child.on('exit', (code: number | null) => {
      if (job.stdoutBuf) {
        job.stdoutLines.push(job.stdoutBuf);
        job.stdoutBuf = '';
      }
      if (job.stderrBuf) {
        job.stderrLines.push(job.stderrBuf);
        job.stderrBuf = '';
      }
      job.status = 'exited';
      job.exitCode = code;
    });

    return jobId;
  }

  get(jobId: string): ExecJobSnapshot | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    return {
      jobId,
      status: job.status,
      exitCode: job.exitCode,
      stdout: [...job.stdoutLines],
      stderr: [...job.stderrLines],
    };
  }

  /** SIGTERM every running child. Call from server shutdown. */
  shutdown(): void {
    for (const job of this.jobs.values()) {
      if (job.status === 'running') {
        job.process.kill('SIGTERM');
      }
    }
  }
}

// Append every complete (newline-terminated) line from `buf` into
// `lines`, returning whatever trailing partial line remains.
function drainLines(buf: string, lines: string[]): string {
  let remaining = buf;
  let nl = remaining.indexOf('\n');
  while (nl !== -1) {
    const line = remaining.slice(0, nl);
    // Strip a trailing \r so CRLF streams don't carry CRs into the JSON
    // we later parse on the SPA side.
    lines.push(line.endsWith('\r') ? line.slice(0, -1) : line);
    remaining = remaining.slice(nl + 1);
    nl = remaining.indexOf('\n');
  }

  return remaining;
}
