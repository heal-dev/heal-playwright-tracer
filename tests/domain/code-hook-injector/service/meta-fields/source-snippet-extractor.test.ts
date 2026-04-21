/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 */
import { describe, it, expect } from 'vitest';
import { extractSource } from '../../../../../src/domain/code-hook-injector/service/meta-fields/source-snippet-extractor';

describe('extractSource', () => {
  it('slices the raw source between node.start and node.end', () => {
    const code = `const x = 1 + 2;`;
    const snippet = extractSource(code, { start: 0, end: code.length });
    expect(snippet).toBe('const x = 1 + 2;');
  });

  it('collapses whitespace and trims', () => {
    const code = `foo(\n  a,\n  b\n);`;
    const snippet = extractSource(code, { start: 0, end: code.length });
    expect(snippet).toBe('foo( a, b );');
  });

  it('truncates with an ellipsis past maxLen', () => {
    const code = 'x'.repeat(300);
    const snippet = extractSource(code, { start: 0, end: 300 }, 50);
    expect(snippet).toHaveLength(50);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('returns empty string when offsets are missing', () => {
    expect(extractSource('abc', { start: null, end: null })).toBe('');
    expect(extractSource('abc', null as any)).toBe('');
  });
});
