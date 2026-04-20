import { describe, it, expect, afterEach } from 'vitest';
import { startStdoutCapture } from '../../src/features/test-stdout-capture';

const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;

afterEach(() => {
  // Defensive: in case a test throws mid-capture, put the real writers
  // back so vitest's own reporter isn't routed into the void.
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
});

describe('startStdoutCapture', () => {
  it('captures strings written to stdout/stderr between begin and stop', () => {
    const session = startStdoutCapture();
    process.stdout.write('hello\n');
    process.stderr.write('uh oh\n');
    const { stdout, stderr } = session.stop();
    expect(stdout).toEqual(['hello\n']);
    expect(stderr).toEqual(['uh oh\n']);
  });

  it('restores the original writers after stop()', () => {
    const session = startStdoutCapture();
    session.stop();
    expect(process.stdout.write).toBe(originalStdoutWrite);
    expect(process.stderr.write).toBe(originalStderrWrite);
  });

  it('decodes Buffer chunks to utf8 strings', () => {
    const session = startStdoutCapture();
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

    const session = startStdoutCapture();
    process.stdout.write('carried through');
    session.stop();

    expect(forwarded).toBe('carried through');
  });

  it('returns empty arrays when nothing was written', () => {
    const session = startStdoutCapture();
    const { stdout, stderr } = session.stop();
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
  });
});
