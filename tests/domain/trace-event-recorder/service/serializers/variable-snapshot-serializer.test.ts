/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 *
 */

import { describe, it, expect } from 'vitest';
import {
  safeValue,
  safeVars,
} from '../../../../../src/domain/trace-event-recorder/service/serializers/variable-snapshot-serializer';

describe('safeValue', () => {
  it('passes primitives through', () => {
    expect(safeValue(42)).toBe(42);
    expect(safeValue(true)).toBe(true);
    expect(safeValue(null)).toBe(null);
    expect(safeValue(undefined)).toBe(undefined);
  });

  it('truncates long strings with an ellipsis', () => {
    const long = 'x'.repeat(500);
    const out = safeValue(long) as string;
    expect(out).toHaveLength(198);
    expect(out.endsWith('…')).toBe(true);
  });

  it('renders functions as a short placeholder', () => {
    expect(safeValue(function foo() {})).toBe('[Function foo]');
    expect(safeValue(() => {})).toMatch(/^\[Function /);
  });

  it('renders any class instance as a [Ctor] placeholder without walking', () => {
    class Page {
      innerState = { huge: 'tree' };
      url() {
        return 'x';
      }
    }
    expect(safeValue(new Page())).toBe('[Page]');

    // Same rule applies to non-Playwright classes — this is the SDK-leak
    // guard: walking an adapter would dump enumerable fields like `apiKey`.
    class HttpTracerAdapter {
      apiKey = 'heal_secret_token';
      logger = {};
    }
    expect(safeValue(new HttpTracerAdapter())).toBe('[HttpTracerAdapter]');

    // Built-ins are class instances too.
    expect(safeValue(new Date('2026-04-16'))).toBe('[Date]');
    expect(safeValue(new Set([1, 2, 3]))).toBe('[Set]');
    expect(safeValue(new Map([['a', 1]]))).toBe('[Map]');
  });

  it('walks plain object literals and arrays of plain objects', () => {
    expect(safeValue({ email: 'x@y.com', age: 30 })).toEqual({ email: 'x@y.com', age: 30 });
    expect(safeValue([{ id: 1 }, { id: 2 }])).toEqual([{ id: 1 }, { id: 2 }]);
    expect(safeValue(Object.create(null))).toEqual({});
  });

  it('renders Error instances as a tagged shape', () => {
    const out = safeValue(new TypeError('nope'));
    expect(out).toMatchObject({ __error: true, name: 'TypeError', message: 'nope' });
  });

  it('caps depth at 2 with a [Object] placeholder', () => {
    const v = { a: { b: { c: { d: 1 } } } };
    const out = safeValue(v);
    // depth 0 → {a}, depth 1 → {b}, depth 2 → hits the cap.
    expect(out).toEqual({ a: { b: '[Object]' } });
  });

  it('caps arrays at 10 items with a count suffix', () => {
    const arr = Array.from({ length: 15 }, (_, i) => i);
    const out = safeValue(arr) as unknown[];
    expect(out).toHaveLength(11);
    expect(out[10]).toBe('…5 more');
  });

  it('caps object keys at 10 with a summary key', () => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < 15; i++) obj[`k${i}`] = i;
    const out = safeValue(obj) as Record<string, unknown>;
    expect(Object.keys(out)).toHaveLength(11);
    expect(out['…']).toBe('5 more keys');
  });

  it('replaces throwing getters with a placeholder string', () => {
    const obj = Object.defineProperty({}, 'bad', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    const out = safeValue(obj) as Record<string, unknown>;
    expect(out.bad).toBe('[getter threw]');
  });
});

describe('safeVars', () => {
  it('returns undefined for null/undefined inputs', () => {
    expect(safeVars(undefined)).toBeUndefined();
    expect(safeVars(null)).toBeUndefined();
  });

  it('applies safeValue to each entry', () => {
    expect(safeVars({ a: 1, b: 'two' })).toEqual({ a: 1, b: 'two' });
  });
});
