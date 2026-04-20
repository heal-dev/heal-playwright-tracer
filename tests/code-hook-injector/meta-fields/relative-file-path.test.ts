import { describe, it, expect } from 'vitest';
import { relFile } from '../../../src/code-hook-injector/meta-fields/relative-file-path';

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
