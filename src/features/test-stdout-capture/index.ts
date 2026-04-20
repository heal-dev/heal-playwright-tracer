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
// the patch is always bracketed by a `beginCapture / endCapture`
// pair in the fixture. No concurrent callers, no reentrancy.

type WriteFn = typeof process.stdout.write;

export interface StdoutCaptureSession {
  stop(): { stdout: string[]; stderr: string[] };
}

export function startStdoutCapture(): StdoutCaptureSession {
  const stdoutBuf: string[] = [];
  const stderrBuf: string[] = [];

  // Save the raw property value (not a bound wrapper) so stop() can
  // put back exactly the function that was installed, not an identity
  // copy of it. We restore `this` manually on the forward-call below.

  const origStdout = process.stdout.write;
  const origStderr = process.stderr.write;

  const patchedStdout = function (this: unknown, chunk: unknown, ...rest: unknown[]) {
    stdoutBuf.push(chunkToString(chunk, rest[0]));
    return (origStdout as (...a: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
  } as WriteFn;

  const patchedStderr = function (this: unknown, chunk: unknown, ...rest: unknown[]) {
    stderrBuf.push(chunkToString(chunk, rest[0]));
    return (origStderr as (...a: unknown[]) => boolean).call(process.stderr, chunk, ...rest);
  } as WriteFn;

  process.stdout.write = patchedStdout;
  process.stderr.write = patchedStderr;

  return {
    stop() {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
      return { stdout: stdoutBuf, stderr: stderrBuf };
    },
  };
}

function chunkToString(chunk: unknown, encoding: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) {
    const enc = typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8';
    return Buffer.from(chunk).toString(enc);
  }
  return String(chunk);
}
