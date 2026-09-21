/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeVideoMode,
  shouldKeep,
  shouldRecord,
  videoSizeFrom,
} from '../../../src/infrastructure/playwright-electron-adapter';

describe('normalizeVideoMode', () => {
  it.each([
    [undefined, 'off'],
    ['off', 'off'],
    ['on', 'on'],
    ['retain-on-failure', 'retain-on-failure'],
    ['on-first-retry', 'on-first-retry'],
    ['retry-with-video', 'on-first-retry'], // Playwright's legacy alias
    [{ mode: 'on', size: { width: 640, height: 480 } }, 'on'],
    [{ mode: 'retry-with-video' }, 'on-first-retry'],
    ['bogus', 'off'],
    [{ size: { width: 1, height: 1 } }, 'off'],
    [42, 'off'],
  ])('maps use.video %j to %s', (useVideo, mode) => {
    expect(normalizeVideoMode(useVideo)).toBe(mode);
  });
});

describe('videoSizeFrom', () => {
  it('returns the size of an object-form use.video', () => {
    expect(videoSizeFrom({ mode: 'on', size: { width: 640, height: 480 } })).toEqual({
      width: 640,
      height: 480,
    });
  });

  it.each([['on'], [undefined], [{ mode: 'on' }], [{ mode: 'on', size: { width: 640 } }]])(
    'returns undefined for %j',
    (useVideo) => {
      expect(videoSizeFrom(useVideo)).toBeUndefined();
    },
  );
});

describe('shouldRecord', () => {
  it.each([
    ['off', 0, false],
    ['on', 0, true],
    ['retain-on-failure', 0, true],
    ['on-first-retry', 0, false],
    ['on-first-retry', 1, true],
    ['on-first-retry', 2, false],
  ] as const)('mode %s at retry %i → %s', (mode, retry, expected) => {
    expect(shouldRecord(mode, retry)).toBe(expected);
  });
});

describe('shouldKeep', () => {
  const passed = { status: 'passed', expectedStatus: 'passed', retry: 0 };
  const failed = { status: 'failed', expectedStatus: 'passed', retry: 0 };

  it('never keeps under off, always keeps under on', () => {
    expect(shouldKeep('off', failed)).toBe(false);
    expect(shouldKeep('on', passed)).toBe(true);
  });

  it('retain-on-failure keeps only an outcome that differs from the expected one', () => {
    expect(shouldKeep('retain-on-failure', passed)).toBe(false);
    expect(shouldKeep('retain-on-failure', failed)).toBe(true);
    // A `test.fail()` that fails met its expectation: not kept, like Playwright.
    expect(
      shouldKeep('retain-on-failure', { status: 'failed', expectedStatus: 'failed', retry: 0 }),
    ).toBe(false);
    // A `test.fail()` that unexpectedly passes IS kept.
    expect(
      shouldKeep('retain-on-failure', { status: 'passed', expectedStatus: 'failed', retry: 0 }),
    ).toBe(true);
    // No status at teardown counts as passed.
    expect(
      shouldKeep('retain-on-failure', { status: undefined, expectedStatus: 'passed', retry: 0 }),
    ).toBe(false);
  });

  it('on-first-retry keeps only the first retry', () => {
    expect(shouldKeep('on-first-retry', { ...failed, retry: 0 })).toBe(false);
    expect(shouldKeep('on-first-retry', { ...passed, retry: 1 })).toBe(true);
    expect(shouldKeep('on-first-retry', { ...failed, retry: 2 })).toBe(false);
  });
});

describe('normalizeVideoMode — null', () => {
  it('treats null like an absent value', () => {
    expect(normalizeVideoMode(null)).toBe('off');
    expect(videoSizeFrom(null)).toBeUndefined();
  });
});
