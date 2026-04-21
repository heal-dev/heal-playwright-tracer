/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 *
 */

import { describe, it, expect } from 'vitest';
import { buildMatcher } from '../../../../src/domain/code-hook-injector/service/traced-file-matcher';

describe('buildMatcher', () => {
  it('defaults to matching paths containing /tests/', () => {
    const m = buildMatcher(undefined);
    expect(m('/repo/tests/foo.test.ts')).toBe(true);
    expect(m('/repo/src/foo.ts')).toBe(false);
  });

  it('matches a string entry via includes()', () => {
    const m = buildMatcher('my-suite');
    expect(m('/x/my-suite/a.ts')).toBe(true);
    expect(m('/x/other/a.ts')).toBe(false);
  });

  it('matches a regexp entry via test()', () => {
    const m = buildMatcher(/\.spec\./);
    expect(m('/x/a.spec.ts')).toBe(true);
    expect(m('/x/a.test.ts')).toBe(false);
  });

  it('matches a function entry by truthy return', () => {
    const m = buildMatcher((f: string) => f.endsWith('.ts'));
    expect(m('/x/a.ts')).toBe(true);
    expect(m('/x/a.js')).toBe(false);
  });

  it('accepts an array of mixed entries and matches any', () => {
    const m = buildMatcher([/foo/, 'bar', (f: string) => f.includes('baz')]);
    expect(m('/p/foo.ts')).toBe(true);
    expect(m('/p/bar.ts')).toBe(true);
    expect(m('/p/baz.ts')).toBe(true);
    expect(m('/p/qux.ts')).toBe(false);
  });

  it('returns false for empty filename', () => {
    const m = buildMatcher(undefined);
    expect(m('')).toBe(false);
    expect(m(undefined)).toBe(false);
  });
});
