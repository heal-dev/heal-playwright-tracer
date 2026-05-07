/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { log } from '../../src/util/logger';

describe('logger', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let originalDebug: string | undefined;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    originalDebug = process.env.HEAL_DEBUG;
  });

  afterEach(() => {
    if (originalDebug === undefined) delete process.env.HEAL_DEBUG;
    else process.env.HEAL_DEBUG = originalDebug;
    errSpy.mockRestore();
  });

  it('error: always writes to console.error with [error] prefix', () => {
    delete process.env.HEAL_DEBUG;
    log.error('boom');
    expect(errSpy).toHaveBeenCalledOnce();
    expect(errSpy.mock.calls[0][0]).toBe('[heal-playwright-tracer] [error] boom');
  });

  it('error: includes the error stack when an Error is passed', () => {
    const err = new Error('underlying cause');
    log.error('wrapper message', err);
    const msg = String(errSpy.mock.calls[0][0]);
    expect(msg).toContain('[heal-playwright-tracer] [error] wrapper message');
    expect(msg).toContain('underlying cause');
    // Stack frames live on Error.stack — the logger prefers stack over message.
    expect(msg.split('\n').length).toBeGreaterThan(1);
  });

  it('error: stringifies non-Error rejections', () => {
    log.error('non-error rejection', 'just a string');
    const msg = String(errSpy.mock.calls[0][0]);
    expect(msg).toContain('just a string');
  });

  it('warn: silent when HEAL_DEBUG is unset', () => {
    delete process.env.HEAL_DEBUG;
    log.warn('best-effort failure');
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('warn: silent when HEAL_DEBUG is something other than "1"', () => {
    process.env.HEAL_DEBUG = 'true';
    log.warn('best-effort failure');
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('warn: writes to console.error with [warn] prefix when HEAL_DEBUG=1', () => {
    process.env.HEAL_DEBUG = '1';
    log.warn('best-effort failure');
    expect(errSpy).toHaveBeenCalledOnce();
    expect(errSpy.mock.calls[0][0]).toBe('[heal-playwright-tracer] [warn] best-effort failure');
  });

  it('warn: env var read at log time, not at module load', () => {
    delete process.env.HEAL_DEBUG;
    log.warn('first call'); // not logged
    process.env.HEAL_DEBUG = '1';
    log.warn('second call'); // logged
    delete process.env.HEAL_DEBUG;
    log.warn('third call'); // not logged
    const messages = errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(messages).toEqual(['[heal-playwright-tracer] [warn] second call']);
  });
});
