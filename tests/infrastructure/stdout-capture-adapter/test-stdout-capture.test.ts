/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 *
 */

import { describe, it, expect, afterEach } from 'vitest';
import { StdoutCaptureSession } from '../../../src/infrastructure/stdout-capture-adapter';

const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;

afterEach(() => {
  // Defensive: in case a test throws mid-capture, put the real writers
  // back so vitest's own reporter isn't routed into the void.
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
});

describe('StdoutCaptureSession', () => {
  it('captures strings written to stdout/stderr between begin and stop', () => {
    const session = new StdoutCaptureSession();
    process.stdout.write('hello\n');
    process.stderr.write('uh oh\n');
    const { stdout, stderr } = session.stop();
    expect(stdout).toEqual(['hello\n']);
    expect(stderr).toEqual(['uh oh\n']);
  });

  it('restores the original writers after stop()', () => {
    const session = new StdoutCaptureSession();
    session.stop();
    expect(process.stdout.write).toBe(originalStdoutWrite);
    expect(process.stderr.write).toBe(originalStderrWrite);
  });

  it('decodes Buffer chunks to utf8 strings', () => {
    const session = new StdoutCaptureSession();
    process.stdout.write(Buffer.from('buffered line', 'utf8'));
    const { stdout } = session.stop();
    expect(stdout).toEqual(['buffered line']);
  });

  it('forwards the chunk to the real writer so output is not silenced', () => {
    let forwarded: string | null = null;
    const fakeOriginal = (chunk: unknown): boolean => {
      forwarded = typeof chunk === 'string' ? chunk : String(chunk);
      return true;
    };
    process.stdout.write = fakeOriginal as typeof process.stdout.write;

    const session = new StdoutCaptureSession();
    process.stdout.write('carried through');
    session.stop();

    expect(forwarded).toBe('carried through');
  });

  it('returns empty arrays when nothing was written', () => {
    const session = new StdoutCaptureSession();
    const { stdout, stderr } = session.stop();
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
  });

  it('decodes Uint8Array chunks using an explicit encoding argument', () => {
    const session = new StdoutCaptureSession();
    const buf = Buffer.from('776f726c64', 'hex'); // "world"
    const asUint8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    (process.stdout.write as (c: unknown, e?: unknown) => boolean)(asUint8, 'utf8');
    const { stdout } = session.stop();
    expect(stdout).toEqual(['world']);
  });

  it('falls back to String(chunk) for non-string non-Buffer values', () => {
    // The real Node writer rejects numbers, so swap it for a harmless
    // fake before constructing the session. The patched writer
    // forwards to this fake, which does not care about the type.
    process.stdout.write = (() => true) as typeof process.stdout.write;
    const session = new StdoutCaptureSession();
    (process.stdout.write as (c: unknown) => boolean)(12345 as unknown as string);
    const { stdout } = session.stop();
    expect(stdout).toEqual(['12345']);
  });

  it('stop() is idempotent and returns the same buffers a second time', () => {
    const session = new StdoutCaptureSession();
    process.stdout.write('once');
    const first = session.stop();
    const second = session.stop();
    expect(second).toEqual(first);
    // Second stop must not re-install the patched writer.
    expect(process.stdout.write).toBe(originalStdoutWrite);
  });
});
