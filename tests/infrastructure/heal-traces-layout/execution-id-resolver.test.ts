/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  getExecutionIdSource,
  resetExecutionIdForTesting,
  resolveExecutionId,
} from '../../../src/infrastructure/heal-traces-layout';

describe('resolveExecutionId', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.HEAL_EXECUTION_ID;
    resetExecutionIdForTesting();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.HEAL_EXECUTION_ID;
    } else {
      process.env.HEAL_EXECUTION_ID = originalEnv;
    }
    resetExecutionIdForTesting();
  });

  it('returns HEAL_EXECUTION_ID when set', () => {
    process.env.HEAL_EXECUTION_ID = 'ci-run-42';
    expect(resolveExecutionId()).toBe('ci-run-42');
    expect(getExecutionIdSource()).toBe('env');
  });

  it('falls back to a UUID v4 when HEAL_EXECUTION_ID is unset', () => {
    delete process.env.HEAL_EXECUTION_ID;
    const id = resolveExecutionId();
    // Standard UUID v4 shape: 8-4-4-4-12 hex digits, 13th char is "4".
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(getExecutionIdSource()).toBe('generated');
  });

  it('treats an empty string as unset and falls back to UUID', () => {
    process.env.HEAL_EXECUTION_ID = '';
    const id = resolveExecutionId();
    expect(id).not.toBe('');
    expect(getExecutionIdSource()).toBe('generated');
  });

  it('memoizes the value across repeat calls within a process', () => {
    delete process.env.HEAL_EXECUTION_ID;
    const first = resolveExecutionId();
    const second = resolveExecutionId();
    expect(second).toBe(first);
  });

  it('does not pick up env var changes after the first call', () => {
    delete process.env.HEAL_EXECUTION_ID;
    const generated = resolveExecutionId();
    process.env.HEAL_EXECUTION_ID = 'after-the-fact';
    expect(resolveExecutionId()).toBe(generated);
    expect(getExecutionIdSource()).toBe('generated');
  });

  it('resetExecutionIdForTesting clears the cache', () => {
    delete process.env.HEAL_EXECUTION_ID;
    const first = resolveExecutionId();
    resetExecutionIdForTesting();
    process.env.HEAL_EXECUTION_ID = 'after-reset';
    expect(resolveExecutionId()).toBe('after-reset');
    expect(getExecutionIdSource()).toBe('env');
    // first was a uuid, not equal to 'after-reset'
    expect(first).not.toBe('after-reset');
  });
});
