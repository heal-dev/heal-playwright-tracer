/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 *
 */

// Feature: capture every write to process.stdout / process.stderr for
// the duration of a single test and return them as string arrays when
// the capture session ends.
//
// Why this exists: Playwright's per-test `TestInfo` (the object
// fixtures receive) does NOT expose stdout/stderr — those fields live
// on the reporter-side `TestResult`, which is unreachable from inside
// a fixture. So we intercept writes at the Node level: patch
// `process.stdout.write` / `process.stderr.write`, buffer each chunk
// into our own arrays, and still forward the call to the original
// writer so Playwright's own output (progress, errors, etc.) and
// reporter piping keep working unchanged.
//
// Scope: Playwright runs at most one test per worker at a time, so
// the patch is always bracketed by construction/`stop()` of a single
// session. No concurrent callers, no reentrancy.
//
// This lives in infrastructure because it mutates Node's process
// streams — a technical I/O concern the domain does not own.

type WriteFn = typeof process.stdout.write;

export interface StdoutCaptureResult {
  stdout: string[];
  stderr: string[];
}

export class StdoutCaptureSession {
  private readonly stdoutBuf: string[] = [];
  private readonly stderrBuf: string[] = [];
  private readonly origStdout: WriteFn;
  private readonly origStderr: WriteFn;
  private stopped = false;

  constructor() {
    // Save the raw property value (not a bound wrapper) so stop() can
    // put back exactly the function that was installed, not an identity
    // copy of it. We restore `this` manually on the forward-call below.
    this.origStdout = process.stdout.write;
    this.origStderr = process.stderr.write;

    process.stdout.write = this.makePatched(this.stdoutBuf, this.origStdout, process.stdout);
    process.stderr.write = this.makePatched(this.stderrBuf, this.origStderr, process.stderr);
  }

  stop(): StdoutCaptureResult {
    if (this.stopped) {
      return { stdout: this.stdoutBuf, stderr: this.stderrBuf };
    }
    this.stopped = true;
    process.stdout.write = this.origStdout;
    process.stderr.write = this.origStderr;
    return { stdout: this.stdoutBuf, stderr: this.stderrBuf };
  }

  private makePatched(buf: string[], orig: WriteFn, target: NodeJS.WriteStream): WriteFn {
    return function patched(this: unknown, chunk: unknown, ...rest: unknown[]) {
      buf.push(StdoutCaptureSession.chunkToString(chunk, rest[0]));
      return (orig as (...a: unknown[]) => boolean).call(target, chunk, ...rest);
    } as WriteFn;
  }

  private static chunkToString(chunk: unknown, encoding: unknown): string {
    if (typeof chunk === 'string') return chunk;
    if (chunk instanceof Uint8Array) {
      const enc = typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8';
      return Buffer.from(chunk).toString(enc);
    }
    return String(chunk);
  }
}
