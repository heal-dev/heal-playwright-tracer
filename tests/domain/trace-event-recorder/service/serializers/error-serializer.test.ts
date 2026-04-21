/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */
import { describe, it, expect } from 'vitest';
import { serializeError } from '../../../../../src/domain/trace-event-recorder/service/serializers/error-serializer';

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
    expect(serializeError(undefined)).toEqual({ message: 'undefined' });
  });

  it('returns the error with no stack when .stack is absent', () => {
    const err = new Error('no-stack');
    err.stack = undefined as unknown as string;
    const out = serializeError(err);
    expect(out.stack).toBeUndefined();
    expect(out.message).toBe('no-stack');
  });

  it('falls back to String(err) when .message is missing', () => {
    const bare = { name: 'Weird' } as const;
    const out = serializeError(bare);
    expect(out.message).toBe('[object Object]');
    expect(out.name).toBe('Weird');
  });

  it('truncates .cause chains beyond depth 5', () => {
    let cur: { message: string; cause?: unknown } = { message: 'level-6' };
    cur = { message: 'level-5', cause: cur };
    cur = { message: 'level-4', cause: cur };
    cur = { message: 'level-3', cause: cur };
    cur = { message: 'level-2', cause: cur };
    cur = { message: 'level-1', cause: cur };
    const top = new Error('top');
    (top as unknown as { cause: unknown }).cause = cur;

    const out = serializeError(top);
    expect(out.causes).toHaveLength(5);
    expect(out.causes![0].message).toBe('level-1');
    expect(out.causes![4].message).toBe('level-5');
  });

  it('terminates the cause walk on a primitive cause', () => {
    const top = new Error('top');
    (top as unknown as { cause: unknown }).cause = 'string-cause';

    const out = serializeError(top);
    expect(out.causes).toEqual([{ message: 'string-cause' }]);
  });

  it('serializes non-Error causes via String() when the cause message is missing', () => {
    const top = new Error('top');
    const midCause: Record<string, unknown> = { cause: null };
    (top as unknown as { cause: unknown }).cause = midCause;

    const out = serializeError(top);
    expect(out.causes).toHaveLength(1);
    expect(out.causes![0].message).toBe(String(midCause));
  });

  it('non-Playwright errors are marked isPlaywrightError=false', () => {
    const err = new Error('regular');
    err.stack = 'Error: regular\n    at app/src/foo.ts:1:1';
    const out = serializeError(err);
    expect(out.isPlaywrightError).toBe(false);
  });
});
