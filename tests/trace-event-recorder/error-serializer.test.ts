import { describe, it, expect } from 'vitest';
import { serializeError } from '../../src/trace-event-recorder/error-serializer';

describe('serializeError', () => {
  it('extracts name, message, stack', () => {
    const err = new RangeError('bad');
    const out = serializeError(err);
    expect(out.name).toBe('RangeError');
    expect(out.message).toBe('bad');
    expect(typeof out.stack).toBe('string');
  });

  it('flags Playwright errors by constructor name', () => {
    class TimeoutError extends Error {
      constructor() {
        super('timed out');
        this.name = 'TimeoutError';
      }
    }
    const out = serializeError(new TimeoutError());
    expect(out.isPlaywrightError).toBe(true);
  });

  it('flags Playwright errors by stack path', () => {
    const err = new Error('x');
    err.stack = 'Error: x\n    at node_modules/@playwright/test/lib/foo.js:1:1';
    const out = serializeError(err);
    expect(out.isPlaywrightError).toBe(true);
  });

  it('walks the error cause chain up to 5 deep', () => {
    const root = new Error('root');
    const mid = new Error('mid');
    (mid as unknown as { cause: unknown }).cause = root;
    const top = new Error('top');
    (top as unknown as { cause: unknown }).cause = mid;
    const out = serializeError(top);
    expect(out.causes).toHaveLength(2);
    expect(out.causes![0].message).toBe('mid');
    expect(out.causes![1].message).toBe('root');
  });

  it('handles non-Error throws (strings, numbers, null)', () => {
    expect(serializeError('oops')).toEqual({ message: 'oops' });
    expect(serializeError(null)).toEqual({ message: 'null' });
    expect(serializeError(42)).toEqual({ message: '42' });
  });
});
