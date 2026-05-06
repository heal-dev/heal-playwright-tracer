/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect } from 'vitest';
import {
  isTextualContentType,
  previewBody,
  utf8SafeSlice,
  bytesOnlyPreview,
} from '../../../src/infrastructure/playwright-network-capture-adapter/body-preview';

describe('isTextualContentType', () => {
  it('matches text/* and JSON variants by default', () => {
    expect(isTextualContentType('text/html', undefined)).toBe(true);
    expect(isTextualContentType('text/plain; charset=utf-8', undefined)).toBe(true);
    expect(isTextualContentType('application/json', undefined)).toBe(true);
    expect(isTextualContentType('application/json; charset=utf-8', undefined)).toBe(true);
    expect(isTextualContentType('application/xml', undefined)).toBe(true);
    expect(isTextualContentType('application/x-www-form-urlencoded', undefined)).toBe(true);
  });

  it('rejects binary content types', () => {
    expect(isTextualContentType('image/png', undefined)).toBe(false);
    expect(isTextualContentType('application/zip', undefined)).toBe(false);
    expect(isTextualContentType('application/octet-stream', undefined)).toBe(false);
  });

  it('returns false for missing content-type', () => {
    expect(isTextualContentType(undefined, undefined)).toBe(false);
    expect(isTextualContentType('', undefined)).toBe(false);
  });

  it('respects an explicit allowlist (replaces defaults)', () => {
    const allow = [/^application\/special\b/i];
    expect(isTextualContentType('application/json', allow)).toBe(false);
    expect(isTextualContentType('application/special', allow)).toBe(true);
  });

  it('an empty allowlist disables every content type', () => {
    expect(isTextualContentType('text/html', [])).toBe(false);
  });
});

describe('utf8SafeSlice', () => {
  it('returns the whole string when under the cap', () => {
    expect(utf8SafeSlice(Buffer.from('hello', 'utf8'), 100)).toBe('hello');
  });

  it('cuts to maxBytes when ASCII', () => {
    expect(utf8SafeSlice(Buffer.from('helloworld', 'utf8'), 5)).toBe('hello');
  });

  it('does not split a multi-byte codepoint', () => {
    // 'é' is 0xC3 0xA9 (2 bytes). Slicing at byte index 1 would
    // leave a stray continuation byte; the helper should back up.
    const buf = Buffer.from('aé', 'utf8'); // bytes: 0x61 0xC3 0xA9
    expect(utf8SafeSlice(buf, 2)).toBe('a');
    expect(utf8SafeSlice(buf, 3)).toBe('aé');
  });

  it('handles emoji (4-byte codepoints) safely', () => {
    const buf = Buffer.from('a😀', 'utf8'); // 'a' + 4-byte emoji
    expect(utf8SafeSlice(buf, 1)).toBe('a');
    expect(utf8SafeSlice(buf, 2)).toBe('a');
    expect(utf8SafeSlice(buf, 5)).toBe('a😀');
  });
});

describe('previewBody', () => {
  it('returns bytes/truncated/preview for textual bodies', () => {
    const result = previewBody(Buffer.from('hello', 'utf8'), 100, true);
    expect(result.bytes).toBe(5);
    expect(result.truncated).toBe(false);
    expect(result.preview).toBe('hello');
  });

  it('flips truncated when the body is bigger than the cap', () => {
    const result = previewBody(Buffer.from('helloworld', 'utf8'), 5, true);
    expect(result.bytes).toBe(10);
    expect(result.truncated).toBe(true);
    expect(result.preview).toBe('hello');
  });

  it('omits preview when decodeAsText is false', () => {
    const result = previewBody(Buffer.from('hello', 'utf8'), 100, false);
    expect(result.bytes).toBe(5);
    expect(result.truncated).toBe(false);
    expect(result.preview).toBeUndefined();
  });
});

describe('bytesOnlyPreview', () => {
  it('returns the size with truncated:false when bytes is known', () => {
    expect(bytesOnlyPreview(42)).toEqual({ bytes: 42, truncated: false });
  });

  it('returns undefined when bytes is unknown', () => {
    expect(bytesOnlyPreview(undefined)).toBeUndefined();
    expect(bytesOnlyPreview(NaN)).toBeUndefined();
  });
});
