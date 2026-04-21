/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestInfo } from '@playwright/test';
import { PlaywrightTestContextAdapter } from '../../../src/infrastructure/playwright-test-context-adapter';

const setContext = vi.fn();
const hooks = { setContext };

let adapter = new PlaywrightTestContextAdapter(hooks);
const captureTestContext = (info: TestInfo) => adapter.capture(info);

function makeTestInfo(overrides: Partial<TestInfo> = {}): TestInfo {
  return {
    testId: 'tid-1',
    title: 't',
    titlePath: ['t'],
    file: '/repo/x.test.ts',
    project: { name: 'default' } as TestInfo['project'],
    workerIndex: 0,
    parallelIndex: 0,
    retry: 0,
    annotations: [],
    tags: [],
    ...overrides,
  } as unknown as TestInfo;
}

beforeEach(() => {
  setContext.mockReset();
  adapter = new PlaywrightTestContextAdapter(hooks);
});

describe('captureTestContext — correlation identifiers', () => {
  it('returns testId and 1-indexed attempt derived from testInfo', () => {
    const captured = captureTestContext(makeTestInfo({ testId: 'abc-123', retry: 2 }));

    expect(captured).toMatchObject({ testId: 'abc-123', attempt: 3 });
    expect(setContext.mock.calls[0][0]).toMatchObject({
      testId: 'abc-123',
      attempt: 3,
      retry: 2,
    });
  });

  it('shares testId across attempts of the same test (caller drives attempt via retry)', () => {
    const firstRun = captureTestContext(makeTestInfo({ testId: 'same-test', retry: 0 }));
    const retry = captureTestContext(makeTestInfo({ testId: 'same-test', retry: 1 }));

    expect(firstRun.testId).toBe(retry.testId);
    expect(firstRun.attempt).toBe(1);
    expect(retry.attempt).toBe(2);
  });
});

describe('captureTestContext — @heal-<id> tag', () => {
  it('extracts numeric testCaseId from the @heal- tag and forwards it to setContext', () => {
    const info = makeTestInfo({ tags: ['@heal-42'] });

    const captured = captureTestContext(info);

    expect(captured.testCaseId).toBe(42);
    expect(setContext).toHaveBeenCalledTimes(1);
    expect(setContext.mock.calls[0][0]).toMatchObject({ testCaseId: 42 });
  });

  it('omits testCaseId structurally when no @heal- tag is present', () => {
    const captured = captureTestContext(makeTestInfo({ tags: ['@smoke', '@slow'] }));

    expect(Object.prototype.hasOwnProperty.call(captured, 'testCaseId')).toBe(false);
    const ctxArg = setContext.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(ctxArg, 'testCaseId')).toBe(false);
  });

  it('treats a bare @heal- tag with empty suffix as missing', () => {
    const captured = captureTestContext(makeTestInfo({ tags: ['@heal-'] }));

    expect(Object.prototype.hasOwnProperty.call(captured, 'testCaseId')).toBe(false);
  });

  it('treats a non-numeric suffix as missing', () => {
    const captured = captureTestContext(makeTestInfo({ tags: ['@heal-tc_abc'] }));

    expect(Object.prototype.hasOwnProperty.call(captured, 'testCaseId')).toBe(false);
  });

  it('treats a leading-zero suffix as missing (ambiguous with zero-padded ids)', () => {
    const captured = captureTestContext(makeTestInfo({ tags: ['@heal-007'] }));

    expect(Object.prototype.hasOwnProperty.call(captured, 'testCaseId')).toBe(false);
  });

  it('treats a zero suffix as missing (ids start at 1)', () => {
    const captured = captureTestContext(makeTestInfo({ tags: ['@heal-0'] }));

    expect(Object.prototype.hasOwnProperty.call(captured, 'testCaseId')).toBe(false);
  });

  it('treats a negative suffix as missing', () => {
    const captured = captureTestContext(makeTestInfo({ tags: ['@heal--3'] }));

    expect(Object.prototype.hasOwnProperty.call(captured, 'testCaseId')).toBe(false);
  });

  it('ignores unrelated tags and picks the @heal- tag regardless of position', () => {
    const info = makeTestInfo({ tags: ['@smoke', '@heal-99', '@slow'] });

    const captured = captureTestContext(info);

    expect(captured.testCaseId).toBe(99);
  });

  it('picks the first @heal- tag when duplicated', () => {
    const info = makeTestInfo({ tags: ['@heal-1', '@heal-2'] });

    const captured = captureTestContext(info);

    expect(captured.testCaseId).toBe(1);
  });
});
