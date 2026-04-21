/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 */
import { describe, it, expect } from 'vitest';
import { relFile } from '../../../../../src/domain/code-hook-injector/service/meta-fields/relative-file-path';

describe('relFile', () => {
  it('returns a path relative to cwd when inside it', () => {
    expect(relFile('/repo', '/repo/src/foo.ts')).toBe('src/foo.ts');
  });

  it('returns the absolute path when outside cwd', () => {
    expect(relFile('/repo', '/elsewhere/x.ts')).toBe('/elsewhere/x.ts');
  });

  it('returns <anonymous> for missing filename', () => {
    expect(relFile('/repo', undefined)).toBe('<anonymous>');
  });
});
