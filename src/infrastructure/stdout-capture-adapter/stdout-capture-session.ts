/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

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
