/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 */
import { describe, it, expect } from 'vitest';
import { extractLeadingComment } from '../../../../../src/domain/code-hook-injector/service/meta-fields/leading-comment-extractor';

describe('extractLeadingComment', () => {
  it('returns null when the node has no leadingComments', () => {
    expect(extractLeadingComment({})).toBeNull();
    expect(extractLeadingComment(null)).toBeNull();
    expect(extractLeadingComment(undefined)).toBeNull();
  });

  it('returns null for an empty leadingComments array', () => {
    expect(extractLeadingComment({ leadingComments: [] })).toBeNull();
  });

  it('strips one leading space from a line comment', () => {
    // Babel stores `// foo` as `{ type: 'CommentLine', value: ' foo' }`.
    const out = extractLeadingComment({
      leadingComments: [{ type: 'CommentLine', value: ' foo' }],
    });
    expect(out).toBe('foo');
  });

  it('strips one leading and one trailing space from a block comment', () => {
    // `/* foo */` → ` foo `
    const out = extractLeadingComment({
      leadingComments: [{ type: 'CommentBlock', value: ' foo ' }],
    });
    expect(out).toBe('foo');
  });

  it('preserves JSDoc-style indentation (only ONE space stripped per side)', () => {
    // `/**\n * a\n * b\n */` → `*\n * a\n * b\n `
    // We strip exactly one leading + one trailing space, so the
    // inner `' * a'` indentation survives.
    const out = extractLeadingComment({
      leadingComments: [{ type: 'CommentBlock', value: '*\n * a\n * b\n ' }],
    });
    expect(out).toBe('*\n * a\n * b\n');
  });

  it('joins multiple stacked comments with \\n in source order', () => {
    const out = extractLeadingComment({
      leadingComments: [
        { type: 'CommentLine', value: ' first' },
        { type: 'CommentLine', value: ' second' },
        { type: 'CommentLine', value: ' third' },
      ],
    });
    expect(out).toBe('first\nsecond\nthird');
  });

  it('does not strip // or /* */ delimiters (they are not in value)', () => {
    // Contract check: Babel never includes the delimiters in value,
    // so the extractor must not try to strip them either. Passing a
    // value that literally begins with `//` means the author wrote
    // `// //foo`, and the second `//` should survive.
    const out = extractLeadingComment({
      leadingComments: [{ type: 'CommentLine', value: ' //foo' }],
    });
    expect(out).toBe('//foo');
  });
});
