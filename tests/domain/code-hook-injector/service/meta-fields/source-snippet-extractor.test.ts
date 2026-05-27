/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
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

  describe('_healSyntheticSource override', () => {
    // Synthetic nodes injected by the Babel plugin (the
    // `__heal_expect_screenshot` helper line in front of every
    // `await expect(...)`) carry their source string as a property
    // because they have no position in the user's file to slice.
    it('returns the synthetic source verbatim when set, ignoring code/start/end', () => {
      const snippet = extractSource('unrelated file content', {
        start: 0,
        end: 5,
        _healSyntheticSource: 'await __heal_expect_screenshot(loc)',
      });
      expect(snippet).toBe('await __heal_expect_screenshot(loc)');
    });

    it('collapses whitespace and trims the synthetic source like a normal slice', () => {
      const snippet = extractSource(null, {
        _healSyntheticSource: '  await __heal_expect_screenshot(\n  loc\n)  ',
      });
      expect(snippet).toBe('await __heal_expect_screenshot( loc )');
    });

    it('truncates a long synthetic source with an ellipsis past maxLen', () => {
      const snippet = extractSource(null, { _healSyntheticSource: 'x'.repeat(300) }, 50);
      expect(snippet).toHaveLength(50);
      expect(snippet.endsWith('…')).toBe(true);
    });

    it('still returns empty string when synthetic source is absent AND offsets are missing', () => {
      // No code, no offsets, no synthetic source → empty (regression
      // guard for the order of fallback checks).
      expect(extractSource(null, {})).toBe('');
    });
  });
});
