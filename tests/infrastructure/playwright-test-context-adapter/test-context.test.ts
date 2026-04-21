/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestInfo } from '@playwright/test';
import { PlaywrightTestContextAdapter } from '../../../src/infrastructure/playwright-test-context-adapter';

const setContext = vi.fn();
const hooks = { setContext };

// Fresh adapter per test so the runId cache does not leak assertions
// between cases.
let adapter = new PlaywrightTestContextAdapter(hooks);
const captureTestContext = (info: TestInfo, _hooks = hooks) => adapter.capture(info);

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
  delete process.env.HEAL_EXECUTION_ID;
});

afterEach(() => {
  delete process.env.HEAL_EXECUTION_ID;
});

describe('captureTestContext — @heal-<id> tag', () => {
  it('extracts numeric testCaseId from the @heal- tag and forwards it to setContext', () => {
    const info = makeTestInfo({ tags: ['@heal-42'] });

    const captured = captureTestContext(info, hooks);

    expect(captured.testCaseId).toBe(42);
    expect(setContext).toHaveBeenCalledTimes(1);
    expect(setContext.mock.calls[0][0]).toMatchObject({ testCaseId: 42 });
  });

  it('omits testCaseId structurally when no @heal- tag is present', () => {
    const captured = captureTestContext(makeTestInfo({ tags: ['@smoke', '@slow'] }), hooks);

    expect(Object.prototype.hasOwnProperty.call(captured, 'testCaseId')).toBe(false);
    const ctxArg = setContext.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(ctxArg, 'testCaseId')).toBe(false);
  });

  it('treats a bare @heal- tag with empty suffix as missing', () => {
    const captured = captureTestContext(makeTestInfo({ tags: ['@heal-'] }), hooks);

    expect(Object.prototype.hasOwnProperty.call(captured, 'testCaseId')).toBe(false);
  });

  it('treats a non-numeric suffix as missing', () => {
    const captured = captureTestContext(makeTestInfo({ tags: ['@heal-tc_abc'] }), hooks);

    expect(Object.prototype.hasOwnProperty.call(captured, 'testCaseId')).toBe(false);
  });

  it('treats a leading-zero suffix as missing (ambiguous with zero-padded ids)', () => {
    const captured = captureTestContext(makeTestInfo({ tags: ['@heal-007'] }), hooks);

    expect(Object.prototype.hasOwnProperty.call(captured, 'testCaseId')).toBe(false);
  });

  it('treats a zero suffix as missing (ids start at 1)', () => {
    const captured = captureTestContext(makeTestInfo({ tags: ['@heal-0'] }), hooks);

    expect(Object.prototype.hasOwnProperty.call(captured, 'testCaseId')).toBe(false);
  });

  it('treats a negative suffix as missing', () => {
    const captured = captureTestContext(makeTestInfo({ tags: ['@heal--3'] }), hooks);

    expect(Object.prototype.hasOwnProperty.call(captured, 'testCaseId')).toBe(false);
  });

  it('ignores unrelated tags and picks the @heal- tag regardless of position', () => {
    const info = makeTestInfo({ tags: ['@smoke', '@heal-99', '@slow'] });

    const captured = captureTestContext(info, hooks);

    expect(captured.testCaseId).toBe(99);
  });

  it('picks the first @heal- tag when duplicated', () => {
    const info = makeTestInfo({ tags: ['@heal-1', '@heal-2'] });

    const captured = captureTestContext(info, hooks);

    expect(captured.testCaseId).toBe(1);
  });

  it('coexists with executionId from env', () => {
    process.env.HEAL_EXECUTION_ID = 'exec-42';
    const info = makeTestInfo({ tags: ['@heal-7'] });

    const captured = captureTestContext(info, hooks);

    expect(captured).toMatchObject({ executionId: 'exec-42', testCaseId: 7 });
    expect(setContext.mock.calls[0][0]).toMatchObject({
      executionId: 'exec-42',
      testCaseId: 7,
    });
  });
});
