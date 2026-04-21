/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 */
import * as fs from 'fs';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// The adapter now takes `onScreenshotWritten` as an explicit argument,
// so the module-level mock the old test had is gone. Each test passes
// `mockSetScreenshot` directly to `startLocatorScreenshotCapture`.

import {
  startLocatorScreenshotCapture,
  wrapExpect,
} from '../../../src/infrastructure/playwright-locator-screenshot-adapter';

const mockSetScreenshot = vi.fn<(filename: string) => void>();

// --- Fake Page / Locator ---------------------------------------------------
//
// The feature works by replacing methods on the Locator prototype it
// discovers via `samplePage.locator('body')`. We build a fake with the
// same shape: a class whose prototype has the patchable action methods.
// Every test uses a fresh class so the `Symbol.for(...-patched)` marker
// on one prototype doesn't leak into the next.

interface CallLog {
  name: string;
  args: unknown[];
}

function makeFakePageAndLocatorClass() {
  const log: CallLog[] = [];
  const screenshotPaths: string[] = [];
  const evalCalls: Array<{ fn: unknown; arg: unknown }> = [];

  const fakePage = {
    locator(_selector: string) {
      return new FakeLocator();
    },
    async evaluate(fn: unknown, arg: unknown) {
      evalCalls.push({ fn, arg });
      log.push({ name: 'page.evaluate', args: [arg] });
    },
    async screenshot(opts: { path: string }) {
      screenshotPaths.push(opts.path);
      log.push({ name: 'page.screenshot', args: [opts] });
    },
  };

  class FakeLocator {
    async click(...args: unknown[]) {
      log.push({ name: 'locator.click', args });
      return 'clicked';
    }
    async fill(...args: unknown[]) {
      log.push({ name: 'locator.fill', args });
    }
    async boundingBox() {
      log.push({ name: 'locator.boundingBox', args: [] });
      return { x: 10, y: 20, width: 100, height: 50 };
    }
    page() {
      return fakePage;
    }
  }

  return { fakePage, FakeLocator, log, screenshotPaths, evalCalls };
}

describe('locator-screenshots', () => {
  beforeEach(() => {
    mockSetScreenshot.mockReset();
  });

  it('runs boundingBox → overlay → screenshot → action → remove overlay in order', async () => {
    const { fakePage, FakeLocator, log, screenshotPaths } = makeFakePageAndLocatorClass();
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot);

    const loc = new FakeLocator();
    const result = await loc.click('opts');

    expect(result).toBe('clicked');
    const names = log.map((c) => c.name);
    expect(names).toEqual([
      'locator.boundingBox',
      'page.evaluate', // draw overlay
      'page.screenshot',
      'locator.click', // the real action, after the screenshot
      'page.evaluate', // remove overlay
    ]);
    expect(screenshotPaths).toEqual(['/tmp/out/highlight-1-click.png']);
  });

  it('stamps the captured filename onto the active statement via setCurrentStatementScreenshot', async () => {
    const { fakePage, FakeLocator } = makeFakePageAndLocatorClass();
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot);

    const loc = new FakeLocator();
    await loc.click();

    expect(mockSetScreenshot).toHaveBeenCalledTimes(1);
    expect(mockSetScreenshot).toHaveBeenCalledWith('highlight-1-click.png');
  });

  it('increments the sequence across distinct action calls', async () => {
    const { fakePage, FakeLocator, screenshotPaths } = makeFakePageAndLocatorClass();
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot);

    const loc = new FakeLocator();
    await loc.click();
    await loc.fill('hello');

    expect(screenshotPaths).toEqual([
      '/tmp/out/highlight-1-click.png',
      '/tmp/out/highlight-2-fill.png',
    ]);
    expect(mockSetScreenshot.mock.calls.map((c) => c[0])).toEqual([
      'highlight-1-click.png',
      'highlight-2-fill.png',
    ]);
  });

  it('still runs the action when boundingBox returns null', async () => {
    const { fakePage, FakeLocator, log, screenshotPaths } = makeFakePageAndLocatorClass();
    // Override boundingBox to simulate a detached element.
    (FakeLocator.prototype as { boundingBox: () => Promise<unknown> }).boundingBox =
      async function () {
        log.push({ name: 'locator.boundingBox', args: [] });
        return null;
      };
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot);

    const loc = new FakeLocator();
    await loc.click();

    // No overlay, no screenshot, no stamp — but the action still ran.
    expect(screenshotPaths).toEqual([]);
    expect(log.map((c) => c.name)).toEqual(['locator.boundingBox', 'locator.click']);
    expect(mockSetScreenshot).not.toHaveBeenCalled();
  });

  it('skips capture entirely after the session ends', async () => {
    const { fakePage, FakeLocator, screenshotPaths } = makeFakePageAndLocatorClass();
    const stop = startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot);
    stop();

    const loc = new FakeLocator();
    await loc.click();

    expect(screenshotPaths).toEqual([]);
    expect(mockSetScreenshot).not.toHaveBeenCalled();
  });

  it('uses CDP Page.captureScreenshot when the page supports it', async () => {
    const { fakePage, FakeLocator, screenshotPaths } = makeFakePageAndLocatorClass();
    const pngBase64 = Buffer.from('fake-png-bytes').toString('base64');
    const sendMock = vi.fn().mockResolvedValue({ data: pngBase64 });
    const newCDPSessionMock = vi.fn().mockResolvedValue({ send: sendMock, detach: vi.fn() });
    (fakePage as unknown as { context: () => unknown }).context = () => ({
      newCDPSession: newCDPSessionMock,
    });
    const writeFileSpy = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined as never);

    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot);
    const loc = new FakeLocator();
    await loc.click();

    expect(newCDPSessionMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith('Page.captureScreenshot', { format: 'png' });
    expect(writeFileSpy).toHaveBeenCalledWith(
      '/tmp/out/highlight-1-click.png',
      Buffer.from('fake-png-bytes'),
    );
    // Fallback page.screenshot path must not have been touched.
    expect(screenshotPaths).toEqual([]);
    expect(mockSetScreenshot).toHaveBeenCalledWith('highlight-1-click.png');
    writeFileSpy.mockRestore();
  });

  it('falls back to page.screenshot when newCDPSession throws (Firefox/WebKit)', async () => {
    const { fakePage, FakeLocator, screenshotPaths } = makeFakePageAndLocatorClass();
    (fakePage as unknown as { context: () => unknown }).context = () => ({
      newCDPSession: vi.fn().mockRejectedValue(new Error('CDP not supported')),
    });
    const writeFileSpy = vi.spyOn(fs.promises, 'writeFile');

    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot);
    const loc = new FakeLocator();
    await loc.click();

    // page.screenshot fallback was used, fs.writeFile was not.
    expect(screenshotPaths).toEqual(['/tmp/out/highlight-1-click.png']);
    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(mockSetScreenshot).toHaveBeenCalledWith('highlight-1-click.png');
    writeFileSpy.mockRestore();
  });

  it('is idempotent — calling startCapture twice does not double-patch', async () => {
    const { fakePage, FakeLocator, log } = makeFakePageAndLocatorClass();
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot);
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot);

    const loc = new FakeLocator();
    await loc.click();

    // Exactly one boundingBox call means the prototype was patched once.
    const boundingBoxCalls = log.filter((c) => c.name === 'locator.boundingBox');
    expect(boundingBoxCalls).toHaveLength(1);
  });
});

// --- wrapExpect (locator-assertion screenshots) ---------------------------

// Mirrors the locator-action tests: we drive a fake `expect` function
// that returns a fake assertion object, and verify wrapExpect inserts
// the boundingBox → overlay → screenshot → assertion → remove overlay
// sequence. A fake Page/Locator are reused from the helper above so
// capture session state and screenshot paths come from the same code
// path as the locator-patch tests.

function makeFakeLocatorInstance() {
  const log: CallLog[] = [];
  const screenshotPaths: string[] = [];

  const fakePage = {
    async evaluate(fn: unknown, arg: unknown) {
      log.push({ name: 'page.evaluate', args: [arg] });
      void fn;
    },
    async screenshot(opts: { path: string }) {
      screenshotPaths.push(opts.path);
      log.push({ name: 'page.screenshot', args: [opts] });
    },
    locator(_selector: string) {
      // Needed only so startLocatorScreenshotCapture can probe the
      // prototype; returns a minimal object.
      return { click: async () => {}, page: () => fakePage };
    },
  };

  const locator = {
    async boundingBox() {
      log.push({ name: 'locator.boundingBox', args: [] });
      return { x: 10, y: 20, width: 100, height: 50 };
    },
    page() {
      return fakePage;
    },
  };

  return { fakePage, locator, log, screenshotPaths };
}

// Fake expect — takes a target and returns a fresh assertion object
// with two `to*` methods and a `.not` getter that returns a sibling
// assertion. `.not.toBeVisible()` exercises the recursive proxy path.
function makeFakeExpect(assertionLog: CallLog[]) {
  const buildAssertion = (negated: boolean) => {
    const assertion: Record<string, unknown> = {
      async toBeVisible(...args: unknown[]) {
        assertionLog.push({ name: negated ? 'not.toBeVisible' : 'toBeVisible', args });
        return 'ok';
      },
      async toHaveText(...args: unknown[]) {
        assertionLog.push({ name: negated ? 'not.toHaveText' : 'toHaveText', args });
        return 'ok';
      },
      describe: 'not-an-assertion-method',
    };
    Object.defineProperty(assertion, 'not', {
      get() {
        return buildAssertion(!negated);
      },
    });
    return assertion;
  };

  const expectFn = Object.assign(
    function fakeExpect(_target: unknown) {
      return buildAssertion(false);
    },
    {
      soft(_target: unknown) {
        return buildAssertion(false);
      },
      poll: 'poll-placeholder',
    },
  );
  return expectFn;
}

describe('wrapExpect — locator assertion screenshots', () => {
  beforeEach(() => {
    mockSetScreenshot.mockReset();
  });

  it('runs boundingBox → overlay → screenshot → assertion → remove overlay in order', async () => {
    const { fakePage, locator, log, screenshotPaths } = makeFakeLocatorInstance();
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot);

    const assertionLog: CallLog[] = [];
    const wrapped = wrapExpect(
      makeFakeExpect(assertionLog) as unknown as (...a: unknown[]) => unknown,
    );
    const assertion = (wrapped as unknown as (t: unknown) => Record<string, unknown>)(locator);
    const result = await (assertion.toBeVisible as () => Promise<unknown>)();

    expect(result).toBe('ok');
    expect(log.map((c) => c.name)).toEqual([
      'locator.boundingBox',
      'page.evaluate', // draw overlay
      'page.screenshot',
      'page.evaluate', // remove overlay
    ]);
    expect(screenshotPaths).toEqual(['/tmp/out/highlight-1-assert-toBeVisible.png']);
    expect(assertionLog.map((c) => c.name)).toEqual(['toBeVisible']);
  });

  it('stamps the captured filename onto the active statement', async () => {
    const { fakePage, locator } = makeFakeLocatorInstance();
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot);

    const wrapped = wrapExpect(makeFakeExpect([]) as unknown as (...a: unknown[]) => unknown);
    const assertion = (wrapped as unknown as (t: unknown) => Record<string, unknown>)(locator);
    await (assertion.toHaveText as (s: string) => Promise<unknown>)('hi');

    expect(mockSetScreenshot).toHaveBeenCalledTimes(1);
    expect(mockSetScreenshot).toHaveBeenCalledWith('highlight-1-assert-toHaveText.png');
  });

  it('wraps .not so `expect(loc).not.toBeVisible()` also screenshots', async () => {
    const { fakePage, locator, screenshotPaths } = makeFakeLocatorInstance();
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot);

    const assertionLog: CallLog[] = [];
    const wrapped = wrapExpect(
      makeFakeExpect(assertionLog) as unknown as (...a: unknown[]) => unknown,
    );
    const assertion = (wrapped as unknown as (t: unknown) => Record<string, unknown>)(locator);
    const not = assertion.not as Record<string, unknown>;
    await (not.toBeVisible as () => Promise<unknown>)();

    expect(screenshotPaths).toEqual(['/tmp/out/highlight-1-assert-toBeVisible.png']);
    expect(assertionLog.map((c) => c.name)).toEqual(['not.toBeVisible']);
    expect(mockSetScreenshot).toHaveBeenCalledWith('highlight-1-assert-toBeVisible.png');
  });

  it('removes the overlay even when the assertion throws', async () => {
    const { fakePage, locator, log } = makeFakeLocatorInstance();
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot);

    const throwingExpect = Object.assign(
      function (_t: unknown) {
        return {
          async toBeVisible() {
            throw new Error('boom');
          },
        };
      },
      { soft: () => ({}), poll: null },
    );
    const wrapped = wrapExpect(throwingExpect as unknown as (...a: unknown[]) => unknown);
    const assertion = (wrapped as unknown as (t: unknown) => Record<string, unknown>)(locator);

    await expect((assertion.toBeVisible as () => Promise<unknown>)()).rejects.toThrow('boom');

    // Both draw (before) and remove (after) overlay evaluate calls ran,
    // even though the assertion threw in between.
    const evaluates = log.filter((c) => c.name === 'page.evaluate');
    expect(evaluates).toHaveLength(2);
  });

  it('leaves non-locator targets untouched', async () => {
    const { fakePage, screenshotPaths } = makeFakeLocatorInstance();
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot);

    const assertionLog: CallLog[] = [];
    const wrapped = wrapExpect(
      makeFakeExpect(assertionLog) as unknown as (...a: unknown[]) => unknown,
    );
    // A plain value — isLocator returns false, so the original
    // assertion comes back unwrapped and no screenshot is taken.
    const assertion = (wrapped as unknown as (t: unknown) => Record<string, unknown>)('hello');
    await (assertion.toBeVisible as () => Promise<unknown>)();

    expect(screenshotPaths).toEqual([]);
    expect(mockSetScreenshot).not.toHaveBeenCalled();
    expect(assertionLog.map((c) => c.name)).toEqual(['toBeVisible']);
  });

  it('copies static members (soft, poll) onto the wrapped expect', () => {
    const assertionLog: CallLog[] = [];
    const wrapped = wrapExpect(
      makeFakeExpect(assertionLog) as unknown as (...a: unknown[]) => unknown,
    );
    const w = wrapped as unknown as {
      soft: (t: unknown) => Record<string, unknown>;
      poll: string;
    };
    expect(typeof w.soft).toBe('function');
    expect(w.poll).toBe('poll-placeholder');
  });

  it('screenshots assertions made via expect.soft(locator)', async () => {
    const { fakePage, locator, screenshotPaths } = makeFakeLocatorInstance();
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot);

    const wrapped = wrapExpect(makeFakeExpect([]) as unknown as (...a: unknown[]) => unknown);
    const soft = (wrapped as unknown as { soft: (t: unknown) => Record<string, unknown> }).soft;
    const assertion = soft(locator);
    await (assertion.toBeVisible as () => Promise<unknown>)();

    expect(screenshotPaths).toEqual(['/tmp/out/highlight-1-assert-toBeVisible.png']);
    expect(mockSetScreenshot).toHaveBeenCalledWith('highlight-1-assert-toBeVisible.png');
  });
});
