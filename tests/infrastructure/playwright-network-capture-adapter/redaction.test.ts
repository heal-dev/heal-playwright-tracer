/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect } from 'vitest';
import {
  redactHeaders,
  REDACTED_MARKER,
  DEFAULT_REDACT_HEADERS,
} from '../../../src/infrastructure/playwright-network-capture-adapter/redaction';

describe('redactHeaders', () => {
  it('substitutes the marker for default-denylisted header values', () => {
    const out = redactHeaders({
      Authorization: 'Bearer hunter2',
      Cookie: 'session=abc',
      'X-Trace-Id': 'plain-value',
    });
    expect(out['Authorization']).toBe(REDACTED_MARKER);
    expect(out['Cookie']).toBe(REDACTED_MARKER);
    expect(out['X-Trace-Id']).toBe('plain-value');
  });

  it('matches header names case-insensitively', () => {
    const out = redactHeaders({
      AUTHORIZATION: 'Bearer hunter2',
      'set-cookie': 'session=abc',
      'X-Api-Key': 'k',
    });
    expect(out['AUTHORIZATION']).toBe(REDACTED_MARKER);
    expect(out['set-cookie']).toBe(REDACTED_MARKER);
    expect(out['X-Api-Key']).toBe(REDACTED_MARKER);
  });

  it('preserves the original header-name casing in the output', () => {
    const out = redactHeaders({ Authorization: 'Bearer hunter2' });
    expect(Object.keys(out)).toEqual(['Authorization']);
  });

  it('extends, not replaces, the default denylist', () => {
    const out = redactHeaders({ Authorization: 'Bearer hunter2', 'X-Custom-Token': 'abc' }, [
      'x-custom-token',
    ]);
    expect(out['Authorization']).toBe(REDACTED_MARKER);
    expect(out['X-Custom-Token']).toBe(REDACTED_MARKER);
  });

  it('does not mutate the input object', () => {
    const input = { Cookie: 'session=abc' };
    redactHeaders(input);
    expect(input.Cookie).toBe('session=abc');
  });

  it('exposes a frozen default denylist that still contains the canonical credential headers', () => {
    expect(DEFAULT_REDACT_HEADERS).toContain('authorization');
    expect(DEFAULT_REDACT_HEADERS).toContain('cookie');
    expect(DEFAULT_REDACT_HEADERS).toContain('set-cookie');
  });
});
