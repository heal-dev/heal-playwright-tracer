/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import * as fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The adapter now takes `onScreenshotWritten` as an explicit argument,
// so the module-level mock the old test had is gone. Each test passes
// `mockSetScreenshot` directly to `startLocatorScreenshotCapture`.

import {
  startLocatorScreenshotCapture,
  expectScreenshotHelper,
} from '../../../src/infrastructure/playwright-locator-screenshot-adapter';
import {
  setActivePageStamper,
  type PageStamper,
} from '../../../src/infrastructure/playwright-page-registry-adapter';
import { setActiveCaptureSession } from '../../../src/infrastructure/playwright-locator-screenshot-adapter/locator-patch';
import { HEAL_EXPECT_SCREENSHOT } from '../../../src/domain/trace-event-recorder/model/global-names';

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
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);

    const loc = new FakeLocator();
    const result = await loc.click('opts');

    expect(result).toBe('clicked');
    const names = log.map((c) => c.name);
    expect(names).toEqual([
      'page.evaluate', // wait for page idle (fonts.ready + rAF)
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
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);

    const loc = new FakeLocator();
    await loc.click();

    expect(mockSetScreenshot).toHaveBeenCalledTimes(1);
    expect(mockSetScreenshot).toHaveBeenCalledWith('highlight-1-click.png');
  });

  it('increments the sequence across distinct action calls', async () => {
    const { fakePage, FakeLocator, screenshotPaths } = makeFakePageAndLocatorClass();
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);

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
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);

    const loc = new FakeLocator();
    await loc.click();

    // No overlay, no screenshot, no stamp — but the action still ran.
    // The page-idle wait runs before measureBox, so its page.evaluate
    // is present even though capture bails on the null box.
    expect(screenshotPaths).toEqual([]);
    expect(log.map((c) => c.name)).toEqual([
      'page.evaluate', // wait for page idle
      'locator.boundingBox',
      'locator.click',
    ]);
    expect(mockSetScreenshot).not.toHaveBeenCalled();
  });

  it('skips capture entirely after the session ends', async () => {
    const { fakePage, FakeLocator, screenshotPaths } = makeFakePageAndLocatorClass();
    const stop = startLocatorScreenshotCapture(
      fakePage as never,
      '/tmp/out',
      mockSetScreenshot,
      1000,
    );
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

    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);
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
    const { fakePage, FakeLocator, log, screenshotPaths } = makeFakePageAndLocatorClass();
    (fakePage as unknown as { context: () => unknown }).context = () => ({
      newCDPSession: vi.fn().mockRejectedValue(new Error('CDP not supported')),
    });
    const writeFileSpy = vi.spyOn(fs.promises, 'writeFile');

    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);
    const loc = new FakeLocator();
    await loc.click();

    // page.screenshot fallback was used, fs.writeFile was not.
    expect(screenshotPaths).toEqual(['/tmp/out/highlight-1-click.png']);
    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(mockSetScreenshot).toHaveBeenCalledWith('highlight-1-click.png');

    // Fallback must propagate the screenshot timeout — Playwright's
    // default action timeout on `page.screenshot` would otherwise
    // let decoration outlast the action it is decorating.
    const shotCall = log.find((c) => c.name === 'page.screenshot');
    expect(shotCall).toBeDefined();
    expect((shotCall!.args[0] as { timeout?: number }).timeout).toBe(1000);

    writeFileSpy.mockRestore();
  });

  it('propagates a custom screenshotTimeoutMs through to page.screenshot fallback', async () => {
    const { fakePage, FakeLocator, log } = makeFakePageAndLocatorClass();
    (fakePage as unknown as { context: () => unknown }).context = () => ({
      newCDPSession: vi.fn().mockRejectedValue(new Error('CDP not supported')),
    });

    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 250);
    const loc = new FakeLocator();
    await loc.click();

    const shotCall = log.find((c) => c.name === 'page.screenshot');
    expect((shotCall!.args[0] as { timeout?: number }).timeout).toBe(250);
  });

  it('falls back to JS overlay when newCDPSession hangs (withTimeout fires within the cap)', async () => {
    const { fakePage, FakeLocator, screenshotPaths } = makeFakePageAndLocatorClass();
    // newCDPSession never resolves — withTimeout must fire and the
    // session must be cached as null so subsequent calls take the
    // JS path immediately.
    (fakePage as unknown as { context: () => unknown }).context = () => ({
      newCDPSession: vi.fn(() => new Promise(() => {})),
    });

    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 50);
    const loc = new FakeLocator();
    const start = Date.now();
    await loc.click();
    const elapsed = Date.now() - start;

    // JS fallback ran via page.screenshot — proves we did not hang
    // waiting for CDP setup.
    expect(screenshotPaths).toEqual(['/tmp/out/highlight-1-click.png']);
    expect(mockSetScreenshot).toHaveBeenCalledWith('highlight-1-click.png');
    // Capped at 50ms; allow generous slack for CI.
    expect(elapsed).toBeLessThan(1000);
  });

  it('is idempotent — calling startCapture twice does not double-patch', async () => {
    const { fakePage, FakeLocator, log } = makeFakePageAndLocatorClass();
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);

    const loc = new FakeLocator();
    await loc.click();

    // Exactly one boundingBox call means the prototype was patched once.
    const boundingBoxCalls = log.filter((c) => c.name === 'locator.boundingBox');
    expect(boundingBoxCalls).toHaveLength(1);
  });

  it('caps boundingBox with a short timeout so capture cannot block on a missing locator', async () => {
    const { fakePage, FakeLocator, log } = makeFakePageAndLocatorClass();
    const recordedOptions: unknown[] = [];
    (FakeLocator.prototype as { boundingBox: (o?: unknown) => Promise<unknown> }).boundingBox =
      async function (options?: unknown) {
        recordedOptions.push(options);
        log.push({ name: 'locator.boundingBox', args: [options] });
        return { x: 1, y: 2, width: 3, height: 4 };
      };
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);

    const loc = new FakeLocator();
    await loc.click();

    expect(recordedOptions).toEqual([{ timeout: 1000 }]);
  });

  it('scrolls the target into view before capture on the action path', async () => {
    // Off-viewport elements would otherwise produce screenshots
    // framing empty space. Playwright actions auto-scroll anyway, so
    // doing it here is a no-op for the action's own state and just
    // ensures our screenshot matches what the action will see.
    const { fakePage, FakeLocator, log } = makeFakePageAndLocatorClass();
    const scrollOpts: unknown[] = [];
    (
      FakeLocator.prototype as unknown as {
        scrollIntoViewIfNeeded: (o?: unknown) => Promise<void>;
      }
    ).scrollIntoViewIfNeeded = async function (options?: unknown) {
      scrollOpts.push(options);
      log.push({ name: 'locator.scrollIntoViewIfNeeded', args: [options] });
    };
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);

    const loc = new FakeLocator();
    await loc.click();

    // Scroll happens before any other capture step; the page-idle
    // wait sits between the scroll and the measure so the post-scroll
    // layout has settled before we screenshot.
    expect(log.map((c) => c.name)).toEqual([
      'locator.scrollIntoViewIfNeeded',
      'page.evaluate', // wait for page idle
      'locator.boundingBox',
      'page.evaluate', // draw overlay
      'page.screenshot',
      'locator.click',
      'page.evaluate', // remove overlay
    ]);
    expect(scrollOpts).toEqual([{ timeout: 1000 }]);
  });

  it('does not pass fullPage:true to page.screenshot on the action JS-fallback path', async () => {
    // Symmetric to the assertion-path test below. Action mode
    // already scrolled the target into view, so a viewport capture
    // is sufficient. Forcing fullPage here would inflate every
    // action screenshot for no benefit.
    const { fakePage, FakeLocator, log } = makeFakePageAndLocatorClass();
    (fakePage as unknown as { context: () => unknown }).context = () => ({
      newCDPSession: vi.fn().mockRejectedValue(new Error('CDP not supported')),
    });
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);

    const loc = new FakeLocator();
    await loc.click();

    const shotCall = log.find((c) => c.name === 'page.screenshot');
    expect(shotCall).toBeDefined();
    expect((shotCall!.args[0] as { fullPage?: boolean }).fullPage).not.toBe(true);
  });

  it('does not patch scrollIntoViewIfNeeded — calling it directly takes no screenshot', async () => {
    // `scrollIntoViewIfNeeded` is intentionally excluded from
    // HIGHLIGHTED_LOCATOR_ACTIONS because the capture pipeline
    // calls it itself before every action screenshot. Re-adding
    // it would cause infinite recursion (our pre-screenshot
    // scroll re-entering the patched method). This test pins
    // that contract.
    const { fakePage, FakeLocator, log, screenshotPaths } = makeFakePageAndLocatorClass();
    (
      FakeLocator.prototype as unknown as {
        scrollIntoViewIfNeeded: () => Promise<void>;
      }
    ).scrollIntoViewIfNeeded = async function () {
      log.push({ name: 'locator.scrollIntoViewIfNeeded', args: [] });
    };
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);

    const loc = new FakeLocator();
    await (
      loc as unknown as { scrollIntoViewIfNeeded: () => Promise<void> }
    ).scrollIntoViewIfNeeded();

    expect(log.map((c) => c.name)).toEqual(['locator.scrollIntoViewIfNeeded']);
    expect(screenshotPaths).toEqual([]);
    expect(mockSetScreenshot).not.toHaveBeenCalled();
  });

  it('does not abort capture when scrollIntoViewIfNeeded rejects', async () => {
    const { fakePage, FakeLocator, log, screenshotPaths } = makeFakePageAndLocatorClass();
    (
      FakeLocator.prototype as unknown as {
        scrollIntoViewIfNeeded: (o?: unknown) => Promise<void>;
      }
    ).scrollIntoViewIfNeeded = async function () {
      log.push({ name: 'locator.scrollIntoViewIfNeeded', args: [] });
      throw new Error('detached');
    };
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);

    const loc = new FakeLocator();
    const result = await loc.click();

    expect(result).toBe('clicked');
    expect(screenshotPaths).toEqual(['/tmp/out/highlight-1-click.png']);
    // Scroll attempted, then capture continued normally.
    expect(log[0].name).toBe('locator.scrollIntoViewIfNeeded');
    expect(log.some((c) => c.name === 'page.screenshot')).toBe(true);
  });
});

// --- expect-screenshot runtime helper -------------------------------------

// Tests the runtime side of the expect-screenshot feature: the global
// `__heal_expect_screenshot` function the Babel plugin's injected lines
// resolve to. We reuse the fake Page from the locator-action tests so
// capture session state and screenshot paths come from the same code
// path. The helper is exposed both as a named export and via the
// fixture-installed global slot — we test both shapes.

function makeFakeExpectLocator() {
  const log: CallLog[] = [];
  const screenshotPaths: string[] = [];

  // Class (not a plain object) so its prototype is ProbeLocator.prototype,
  // never Object.prototype — see the note in fakePage.locator below.
  class ProbeLocator {
    async click() {}
    page() {
      return fakePage;
    }
  }

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
      // prototype. MUST be a class instance (not a plain object): the
      // patch grabs `Object.getPrototypeOf(...)`, and a plain object
      // would resolve to `Object.prototype`, marking it patched and
      // poisoning the global marker for every other test's locator.
      return new ProbeLocator();
    },
  };

  const locator = {
    async boundingBox() {
      log.push({ name: 'locator.boundingBox', args: [] });
      return { x: 10, y: 20, width: 100, height: 50 };
    },
    async scrollIntoViewIfNeeded() {
      log.push({ name: 'locator.scrollIntoViewIfNeeded', args: [] });
    },
    // The helper probes count() up-front to detect the
    // "element absent" path. Default to 1 so the highlight pipeline
    // runs; tests that want the no-match branch override this.
    async count() {
      log.push({ name: 'locator.count', args: [] });
      return 1;
    },
    page() {
      return fakePage;
    },
  };

  return { fakePage, locator, log, screenshotPaths };
}

describe('expectScreenshotHelper — expect-side capture pipeline', () => {
  beforeEach(() => {
    mockSetScreenshot.mockReset();
    // Defensive: clear the global slot so a leaked install from a
    // previous test doesn't bleed in.
    delete (globalThis as Record<string, unknown>)[HEAL_EXPECT_SCREENSHOT];
  });

  it('runs count → scroll → idle-wait → measure → overlay → screenshot → remove for a locator', async () => {
    const { fakePage, locator, log, screenshotPaths } = makeFakeExpectLocator();
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);

    await expectScreenshotHelper(locator);

    expect(log.map((c) => c.name)).toEqual([
      'locator.count', // up-front probe — present → continue with highlight path
      'locator.scrollIntoViewIfNeeded',
      'page.evaluate', // wait for page idle
      'locator.boundingBox',
      'page.evaluate', // draw overlay
      'page.screenshot',
      'page.evaluate', // remove overlay
    ]);
    expect(screenshotPaths).toEqual(['/tmp/out/highlight-1-expect.png']);
  });

  it('stamps the captured filename onto the active statement', async () => {
    const { fakePage, locator } = makeFakeExpectLocator();
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);

    await expectScreenshotHelper(locator);

    expect(mockSetScreenshot).toHaveBeenCalledTimes(1);
    expect(mockSetScreenshot).toHaveBeenCalledWith('highlight-1-expect.png');
  });

  it('no-ops for non-Locator targets (plain values, strings, numbers, null)', async () => {
    const { fakePage, screenshotPaths } = makeFakeExpectLocator();
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);

    await expectScreenshotHelper('hello');
    await expectScreenshotHelper(42);
    await expectScreenshotHelper(null);
    await expectScreenshotHelper(undefined);
    await expectScreenshotHelper({ notALocator: true });

    expect(screenshotPaths).toEqual([]);
    expect(mockSetScreenshot).not.toHaveBeenCalled();
  });

  it('no-ops when no capture session is active (helper invoked outside any test)', async () => {
    // Drop any session leaked from a previous test in this file —
    // the active-session registry is module-global, so we have to
    // clear it explicitly to test the "no session" path.
    const { setActiveCaptureSession } =
      await import('../../../src/infrastructure/playwright-locator-screenshot-adapter/locator-patch');
    setActiveCaptureSession(null);

    const { locator, log } = makeFakeExpectLocator();
    await expectScreenshotHelper(locator);
    expect(log).toEqual([]);
  });

  it('installs and uninstalls the global slot via startLocatorScreenshotCapture', async () => {
    const { fakePage, locator } = makeFakeExpectLocator();
    const slot = () =>
      (globalThis as Record<string, unknown>)[HEAL_EXPECT_SCREENSHOT] as
        | ((target: unknown) => Promise<void>)
        | undefined;

    expect(slot()).toBeUndefined();

    const stop = startLocatorScreenshotCapture(
      fakePage as never,
      '/tmp/out',
      mockSetScreenshot,
      1000,
    );
    expect(typeof slot()).toBe('function');

    // Drive the helper through the installed global slot (mirrors
    // what the Babel-injected `await globalThis.__heal_expect_screenshot?.(target)`
    // does in instrumented source).
    await slot()!(locator);
    expect(mockSetScreenshot).toHaveBeenCalledWith('highlight-1-expect.png');

    stop();
    expect(slot()).toBeUndefined();
  });

  it('no-ops when the locator’s `page()` returns null (target detached / context closed)', async () => {
    // Defensive path: a locator whose owning page can no longer be
    // resolved. The helper must short-circuit before touching the
    // session — no screenshot, no error.
    const { fakePage, locator, log } = makeFakeExpectLocator();
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);
    // Replace the locator's `.page()` so it returns null.
    locator.page = (() => null) as unknown as typeof locator.page;

    await expectScreenshotHelper(locator);
    expect(log).toEqual([]);
    expect(mockSetScreenshot).not.toHaveBeenCalled();
  });

  it('honors `{ scroll: false }` for viewport-sensitive matchers', async () => {
    const { fakePage, locator, log } = makeFakeExpectLocator();
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);

    await expectScreenshotHelper(locator, { scroll: false });
    expect(log.some((c) => c.name === 'locator.scrollIntoViewIfNeeded')).toBe(false);
    // The screenshot still gets taken (and stamped) — only the scroll
    // is skipped.
    expect(log.some((c) => c.name === 'page.screenshot')).toBe(true);
    expect(mockSetScreenshot).toHaveBeenCalledTimes(1);
  });

  describe('no-match fallback (count() === 0)', () => {
    it('takes a plain viewport screenshot — no boundingBox, no overlay, no scroll', async () => {
      // Assertion like `toHaveCount(0)` / `toBeHidden()`: the locator
      // matches zero elements. The helper must NOT call boundingBox or
      // scrollIntoView (both auto-wait the full `screenshotTimeoutMs`
      // for an element that will never appear). It still produces a
      // file so the trace shows the page state at the assertion.
      const { fakePage, locator, log, screenshotPaths } = makeFakeExpectLocator();
      locator.count = async () => {
        log.push({ name: 'locator.count', args: [] });
        return 0;
      };
      startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);

      await expectScreenshotHelper(locator);

      // Only count() and a bare page.screenshot — no scroll, no
      // boundingBox, no overlay evaluates.
      expect(log.map((c) => c.name)).toEqual(['locator.count', 'page.screenshot']);
      expect(screenshotPaths).toEqual(['/tmp/out/highlight-1-expect.png']);
      expect(mockSetScreenshot).toHaveBeenCalledWith('highlight-1-expect.png');
    });

    it('falls back to the highlight path when count() throws (defensive)', async () => {
      const { fakePage, locator, log } = makeFakeExpectLocator();
      locator.count = async () => {
        throw new Error('count rejected');
      };
      startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);

      await expectScreenshotHelper(locator);

      // Count probe failed → treat as "present" and run the full
      // highlight pipeline. The boundingBox call confirms we did NOT
      // take the no-match shortcut.
      expect(log.some((c) => c.name === 'locator.boundingBox')).toBe(true);
    });

    it('falls back to the highlight path when count() is missing entirely', async () => {
      const { fakePage, locator, log } = makeFakeExpectLocator();
      delete (locator as { count?: unknown }).count;
      startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);

      await expectScreenshotHelper(locator);

      expect(log.some((c) => c.name === 'locator.boundingBox')).toBe(true);
    });
  });

  it('swallows capture errors so a failing screenshot never breaks the assertion', async () => {
    const { fakePage, locator } = makeFakeExpectLocator();
    // Force `page.screenshot` to reject so capture fails after the
    // overlay has been drawn. The helper should still resolve.
    fakePage.screenshot = async () => {
      throw new Error('screenshot exploded');
    };
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);

    await expect(expectScreenshotHelper(locator)).resolves.toBeUndefined();
  });
});

// --- page-attribution stamp (runs inside the same patched action /
// expect helper as the screenshot capture, but independent of it) -----------

describe('locator-patch — page-attribution stamp', () => {
  beforeEach(() => {
    mockSetScreenshot.mockReset();
    setActivePageStamper(null);
  });
  afterEach(() => setActivePageStamper(null));

  it('invokes the active stamper with the action target page BEFORE the action runs', async () => {
    const { fakePage, FakeLocator, log } = makeFakePageAndLocatorClass();
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);
    const stampedWith: unknown[] = [];
    setActivePageStamper((page) => {
      log.push({ name: 'page-stamp', args: [] });
      stampedWith.push(page);
    });

    const loc = new FakeLocator();
    const result = await loc.click();

    expect(result).toBe('clicked');
    expect(stampedWith).toEqual([fakePage]);
    // The stamp is the very first thing the patched method does — before
    // any capture step and before the real action.
    expect(log[0].name).toBe('page-stamp');
    expect(log.findIndex((c) => c.name === 'page-stamp')).toBeLessThan(
      log.findIndex((c) => c.name === 'locator.click'),
    );
  });

  it('swallows a throwing stamper — the action still runs and returns', async () => {
    const { fakePage, FakeLocator } = makeFakePageAndLocatorClass();
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);
    setActivePageStamper(() => {
      throw new Error('stamp boom');
    });

    const loc = new FakeLocator();
    await expect(loc.click()).resolves.toBe('clicked');
  });

  it('no-ops when no stamper is active — action runs normally', async () => {
    const { fakePage, FakeLocator } = makeFakePageAndLocatorClass();
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);
    setActivePageStamper(null);

    const loc = new FakeLocator();
    await expect(loc.click()).resolves.toBe('clicked');
  });
});

describe('expectScreenshotHelper — page-attribution stamp', () => {
  beforeEach(() => {
    mockSetScreenshot.mockReset();
    setActivePageStamper(null);
    delete (globalThis as Record<string, unknown>)[HEAL_EXPECT_SCREENSHOT];
  });
  afterEach(() => setActivePageStamper(null));

  it('stamps the assertion target page even when screenshots are OFF (no active session)', async () => {
    // The decoupling guarantee: page attribution must work even when the
    // screenshot capture session is absent. Clear the session, install
    // only a stamper, and assert the page is still stamped with no
    // screenshot taken.
    setActiveCaptureSession(null);
    const { locator, fakePage, log } = makeFakeExpectLocator();
    const stampedWith: unknown[] = [];
    setActivePageStamper(((page) => stampedWith.push(page)) as PageStamper);

    await expectScreenshotHelper(locator);

    expect(stampedWith).toEqual([fakePage]);
    expect(log).toEqual([]); // no capture pipeline ran
    expect(mockSetScreenshot).not.toHaveBeenCalled();
  });

  it('swallows a throwing stamper in the expect helper', async () => {
    setActiveCaptureSession(null);
    const { locator } = makeFakeExpectLocator();
    setActivePageStamper(() => {
      throw new Error('stamp boom');
    });

    await expect(expectScreenshotHelper(locator)).resolves.toBeUndefined();
  });

  it('does not stamp for a non-Locator target', async () => {
    setActiveCaptureSession(null);
    const stampedWith: unknown[] = [];
    setActivePageStamper(((page) => stampedWith.push(page)) as PageStamper);

    await expectScreenshotHelper('not-a-locator');
    await expectScreenshotHelper({ nope: true });

    expect(stampedWith).toEqual([]);
  });
});
