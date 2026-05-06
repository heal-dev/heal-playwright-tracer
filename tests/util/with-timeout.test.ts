/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect, vi } from 'vitest';
import { withTimeout } from '../../src/util/with-timeout';

describe('withTimeout', () => {
  it('resolves with the underlying promise when it settles before the timer', async () => {
    const result = await withTimeout(Promise.resolve('done'), 1000, 'fast op');
    expect(result).toBe('done');
  });

  it('rejects with a labeled error when the underlying promise outruns the timer', async () => {
    const hung = new Promise<string>(() => {
      // never resolves
    });
    await expect(withTimeout(hung, 5, 'hung op')).rejects.toThrow(
      /hung op did not settle within 5ms/,
    );
  });

  it('clears the timer on the fast path so a successful resolve does not leak a handle', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    await withTimeout(Promise.resolve(7), 50_000, 'fast op');
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('propagates an underlying rejection unchanged (not wrapped as a timeout)', async () => {
    const failing = Promise.reject(new Error('underlying boom'));
    await expect(withTimeout(failing, 1000, 'op')).rejects.toThrow('underlying boom');
  });
});
