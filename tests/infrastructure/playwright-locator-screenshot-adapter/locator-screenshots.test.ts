/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
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
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);

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
    expect(screenshotPaths).toEqual([]);
    expect(log.map((c) => c.name)).toEqual(['locator.boundingBox', 'locator.click']);
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

    // Scroll happens before any other capture step.
    expect(log.map((c) => c.name)).toEqual([
      'locator.scrollIntoViewIfNeeded',
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

// --- CDP highlight path ---------------------------------------------------
//
// When the page exposes a CDP session and the locator carries an
// `evaluate` method (i.e. is a real Playwright Locator), the highlight
// is drawn natively via `Overlay.highlightNode` and the screenshot is
// captured via the same CDP channel. The JS canvas overlay is bypassed
// entirely, eliminating the boundingBox-vs-screenshot layout-shift
// race that the JS path inherits from `boundingBox()`.

interface CdpCallRecord {
  command: string;
  params: unknown;
}

function makeCdpFakePageAndLocatorClass() {
  const log: CallLog[] = [];
  const screenshotPaths: string[] = [];
  const sendCalls: CdpCallRecord[] = [];
  const sendResponses = new Map<string, () => unknown>();

  const sendMock = vi.fn(async (command: string, params: unknown) => {
    sendCalls.push({ command, params });
    const handler = sendResponses.get(command);
    if (handler) return await handler();
    return {};
  });
  const newCDPSessionMock = vi.fn().mockResolvedValue({ send: sendMock, detach: vi.fn() });

  const fakePage = {
    locator(_selector: string) {
      return new FakeLocator();
    },
    async evaluate(fn: unknown, arg: unknown) {
      log.push({ name: 'page.evaluate', args: [arg] });
      void fn;
    },
    async screenshot(opts: { path: string }) {
      screenshotPaths.push(opts.path);
      log.push({ name: 'page.screenshot', args: [opts] });
    },
    context: () => ({ newCDPSession: newCDPSessionMock }),
  };

  class FakeLocator {
    async click(...args: unknown[]) {
      log.push({ name: 'locator.click', args });
      return 'clicked';
    }
    async boundingBox() {
      log.push({ name: 'locator.boundingBox', args: [] });
      return { x: 10, y: 20, width: 100, height: 50 };
    }
    async evaluate(fn: unknown, arg: unknown) {
      log.push({ name: 'locator.evaluate', args: [arg] });
      void fn;
    }
    page() {
      return fakePage;
    }
  }

  return { fakePage, FakeLocator, log, screenshotPaths, sendCalls, sendResponses };
}

function installCdpHappyPath(sendResponses: Map<string, () => unknown>, pngBase64: string): void {
  sendResponses.set('Runtime.evaluate', () => ({ result: { objectId: 'obj-1' } }));
  sendResponses.set('DOM.requestNode', () => ({ nodeId: 42 }));
  sendResponses.set('Page.captureScreenshot', () => ({ data: pngBase64 }));
}

describe('locator-screenshots — CDP highlight path', () => {
  beforeEach(() => {
    mockSetScreenshot.mockReset();
  });

  it('runs stash → resolve → enable → highlight → screenshot → hide → release in order', async () => {
    const { fakePage, FakeLocator, sendCalls, sendResponses, log } =
      makeCdpFakePageAndLocatorClass();
    const pngBase64 = Buffer.from('fake-png').toString('base64');
    installCdpHappyPath(sendResponses, pngBase64);
    const writeFileSpy = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined as never);

    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);
    const loc = new FakeLocator();
    await loc.click();

    // Expected CDP send order — Overlay.enable runs once on first
    // capture, the rest is the per-action sequence.
    expect(sendCalls.map((c) => c.command)).toEqual([
      'Runtime.evaluate',
      'DOM.requestNode',
      'Overlay.enable',
      'Overlay.highlightNode',
      'Page.captureScreenshot',
      'Overlay.hideHighlight',
      'Runtime.releaseObject',
    ]);

    // Stash bracket: locator.evaluate ran twice (stash then unstash).
    expect(log.filter((c) => c.name === 'locator.evaluate')).toHaveLength(2);
    // JS-overlay path was not touched.
    expect(log.filter((c) => c.name === 'page.evaluate')).toHaveLength(0);
    expect(log.filter((c) => c.name === 'locator.boundingBox')).toHaveLength(0);

    expect(writeFileSpy).toHaveBeenCalledWith(
      '/tmp/out/highlight-1-click.png',
      Buffer.from('fake-png'),
    );
    expect(mockSetScreenshot).toHaveBeenCalledWith('highlight-1-click.png');

    writeFileSpy.mockRestore();
  });

  it('passes a translucent-magenta highlightConfig and the resolved nodeId', async () => {
    const { fakePage, FakeLocator, sendCalls, sendResponses } = makeCdpFakePageAndLocatorClass();
    installCdpHappyPath(sendResponses, Buffer.from('').toString('base64'));
    const writeFileSpy = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined as never);

    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);
    const loc = new FakeLocator();
    await loc.click();

    const highlight = sendCalls.find((c) => c.command === 'Overlay.highlightNode');
    expect(highlight).toBeDefined();
    const params = highlight!.params as {
      highlightConfig: {
        contentColor: { r: number; g: number; b: number; a: number };
        showInfo: boolean;
      };
      nodeId: number;
    };
    expect(params.nodeId).toBe(42);
    expect(params.highlightConfig.contentColor).toEqual({ r: 255, g: 0, b: 255, a: 0.08 });
    expect(params.highlightConfig.showInfo).toBe(false);

    writeFileSpy.mockRestore();
  });

  it('memoizes Overlay.enable across multiple captures on the same session', async () => {
    const { fakePage, FakeLocator, sendCalls, sendResponses } = makeCdpFakePageAndLocatorClass();
    installCdpHappyPath(sendResponses, Buffer.from('').toString('base64'));
    const writeFileSpy = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined as never);

    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);
    const loc = new FakeLocator();
    await loc.click();
    await loc.click();
    await loc.click();

    const enables = sendCalls.filter((c) => c.command === 'Overlay.enable');
    expect(enables).toHaveLength(1);

    writeFileSpy.mockRestore();
  });

  it('hides the highlight and releases the remote object even when the screenshot rejects', async () => {
    const { fakePage, FakeLocator, sendCalls, sendResponses } = makeCdpFakePageAndLocatorClass();
    installCdpHappyPath(sendResponses, '');
    sendResponses.set('Page.captureScreenshot', () => {
      throw new Error('snapshot failed');
    });
    const writeFileSpy = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined as never);

    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);
    const loc = new FakeLocator();
    await loc.click();

    const commands = sendCalls.map((c) => c.command);
    expect(commands).toContain('Overlay.hideHighlight');
    expect(commands).toContain('Runtime.releaseObject');

    writeFileSpy.mockRestore();
  });

  it('falls back to the JS overlay path (reusing the seq) when DOM.requestNode returns no nodeId', async () => {
    const { fakePage, FakeLocator, sendCalls, sendResponses, log } =
      makeCdpFakePageAndLocatorClass();
    const pngBase64 = Buffer.from('fake-png').toString('base64');
    installCdpHappyPath(sendResponses, pngBase64);
    // Detached-stash simulation: requestNode returns no nodeId.
    sendResponses.set('DOM.requestNode', () => ({}));
    const writeFileSpy = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined as never);

    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);
    const loc = new FakeLocator();
    await loc.click();

    const commands = sendCalls.map((c) => c.command);
    // CDP path bailed before highlighting.
    expect(commands).not.toContain('Overlay.highlightNode');
    // Remote object cleanup still ran.
    expect(commands).toContain('Runtime.releaseObject');
    // JS fallback drew the overlay and screenshotted via CDP under
    // the same seq + filename.
    expect(log.some((c) => c.name === 'locator.boundingBox')).toBe(true);
    expect(log.some((c) => c.name === 'page.evaluate')).toBe(true);
    expect(commands).toContain('Page.captureScreenshot');
    expect(writeFileSpy).toHaveBeenCalledWith(
      '/tmp/out/highlight-1-click.png',
      Buffer.from('fake-png'),
    );
    expect(mockSetScreenshot).toHaveBeenCalledWith('highlight-1-click.png');

    writeFileSpy.mockRestore();
  });

  it('caps locator.evaluate (stash + unstash) with a short timeout so the CDP path cannot block', async () => {
    const { fakePage, FakeLocator, log, sendResponses } = makeCdpFakePageAndLocatorClass();
    installCdpHappyPath(sendResponses, Buffer.from('').toString('base64'));
    const writeFileSpy = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined as never);
    const recordedOpts: unknown[] = [];
    (FakeLocator.prototype as { evaluate: (...a: unknown[]) => Promise<unknown> }).evaluate =
      async function (fn: unknown, arg: unknown, options?: unknown) {
        recordedOpts.push(options);
        log.push({ name: 'locator.evaluate', args: [arg, options] });
        void fn;
      };
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);

    const loc = new FakeLocator();
    await loc.click();

    // Both stash and unstash carry the timeout cap.
    expect(recordedOpts).toEqual([{ timeout: 1000 }, { timeout: 1000 }]);

    writeFileSpy.mockRestore();
  });

  it('captures viewport-only on the action path (no captureBeyondViewport)', async () => {
    // Action path scrolls the target into view, so a viewport
    // screenshot is sufficient and keeps the PNG small.
    const { fakePage, FakeLocator, sendCalls, sendResponses } = makeCdpFakePageAndLocatorClass();
    installCdpHappyPath(sendResponses, Buffer.from('').toString('base64'));
    const writeFileSpy = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined as never);

    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);
    const loc = new FakeLocator();
    await loc.click();

    const shotCall = sendCalls.find((c) => c.command === 'Page.captureScreenshot');
    expect(shotCall).toBeDefined();
    expect(shotCall!.params).toEqual({ format: 'png' });

    writeFileSpy.mockRestore();
  });

  it('does not block the action when CDP Page.captureScreenshot wedges — withTimeout fires, fallback runs', async () => {
    const { fakePage, FakeLocator, sendResponses } = makeCdpFakePageAndLocatorClass();
    installCdpHappyPath(sendResponses, '');
    // Page.captureScreenshot never resolves — withTimeout must fire.
    sendResponses.set('Page.captureScreenshot', () => new Promise(() => {}));
    const writeFileSpy = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined as never);

    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 50);
    const loc = new FakeLocator();
    const start = Date.now();
    const result = await loc.click();
    const elapsed = Date.now() - start;

    // Action ran to completion despite the wedged screenshot send.
    expect(result).toBe('clicked');
    // Total time must be far less than the actionTimeout the user
    // would otherwise wait for — both CDP and JS fallback attempts
    // are each capped at 50ms, so well under 1s in aggregate.
    expect(elapsed).toBeLessThan(1000);

    writeFileSpy.mockRestore();
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
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);

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
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);

    const wrapped = wrapExpect(makeFakeExpect([]) as unknown as (...a: unknown[]) => unknown);
    const assertion = (wrapped as unknown as (t: unknown) => Record<string, unknown>)(locator);
    await (assertion.toHaveText as (s: string) => Promise<unknown>)('hi');

    expect(mockSetScreenshot).toHaveBeenCalledTimes(1);
    expect(mockSetScreenshot).toHaveBeenCalledWith('highlight-1-assert-toHaveText.png');
  });

  it('wraps .not so `expect(loc).not.toBeVisible()` also screenshots', async () => {
    const { fakePage, locator, screenshotPaths } = makeFakeLocatorInstance();
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);

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
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);

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
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);

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
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);

    const wrapped = wrapExpect(makeFakeExpect([]) as unknown as (...a: unknown[]) => unknown);
    const soft = (wrapped as unknown as { soft: (t: unknown) => Record<string, unknown> }).soft;
    const assertion = soft(locator);
    await (assertion.toBeVisible as () => Promise<unknown>)();

    expect(screenshotPaths).toEqual(['/tmp/out/highlight-1-assert-toBeVisible.png']);
    expect(mockSetScreenshot).toHaveBeenCalledWith('highlight-1-assert-toBeVisible.png');
  });

  it('does not scroll the target before an assertion screenshot, even when scrollIntoViewIfNeeded exists', async () => {
    // Locator assertions like `toBeInViewport` would change outcome
    // if the tracer scrolled before they ran. The assertion path
    // captures beyond the viewport instead.
    const { fakePage, locator, log } = makeFakeLocatorInstance();
    (locator as { scrollIntoViewIfNeeded?: () => Promise<void> }).scrollIntoViewIfNeeded =
      async function () {
        log.push({ name: 'locator.scrollIntoViewIfNeeded', args: [] });
      };
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);

    const wrapped = wrapExpect(makeFakeExpect([]) as unknown as (...a: unknown[]) => unknown);
    const assertion = (wrapped as unknown as (t: unknown) => Record<string, unknown>)(locator);
    await (assertion.toBeVisible as () => Promise<unknown>)();

    expect(log.some((c) => c.name === 'locator.scrollIntoViewIfNeeded')).toBe(false);
  });

  it('passes fullPage: true to page.screenshot on the assertion JS-fallback path', async () => {
    // Off-viewport assertion targets must still appear in the
    // screenshot. Without CDP, the only way to capture beyond the
    // viewport is `fullPage: true`.
    const { fakePage, locator, log } = makeFakeLocatorInstance();
    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);

    const wrapped = wrapExpect(makeFakeExpect([]) as unknown as (...a: unknown[]) => unknown);
    const assertion = (wrapped as unknown as (t: unknown) => Record<string, unknown>)(locator);
    await (assertion.toBeVisible as () => Promise<unknown>)();

    const shotCall = log.find((c) => c.name === 'page.screenshot');
    expect(shotCall).toBeDefined();
    expect((shotCall!.args[0] as { fullPage?: boolean }).fullPage).toBe(true);
  });

  it('passes captureBeyondViewport: true to CDP Page.captureScreenshot on the assertion CDP path', async () => {
    // CDP equivalent of the JS-fallback fullPage flag: rasterizes
    // the full document so off-viewport targets still appear.
    const { fakePage, locator, log } = makeFakeLocatorInstance();
    const sendCalls: CdpCallRecord[] = [];
    const pngBase64 = Buffer.from('fake-png').toString('base64');
    const sendMock = vi.fn(async (command: string, params: unknown) => {
      sendCalls.push({ command, params });
      if (command === 'Page.captureScreenshot') return { data: pngBase64 };
      return {};
    });
    (fakePage as unknown as { context: () => unknown }).context = () => ({
      newCDPSession: vi.fn().mockResolvedValue({ send: sendMock, detach: vi.fn() }),
    });
    const writeFileSpy = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined as never);

    startLocatorScreenshotCapture(fakePage as never, '/tmp/out', mockSetScreenshot, 1000);
    const wrapped = wrapExpect(makeFakeExpect([]) as unknown as (...a: unknown[]) => unknown);
    const assertion = (wrapped as unknown as (t: unknown) => Record<string, unknown>)(locator);
    await (assertion.toBeVisible as () => Promise<unknown>)();

    // Locator has no `evaluate`, so we go through the JS overlay
    // path but the screenshot itself still goes through CDP. It
    // must carry captureBeyondViewport.
    const shot = sendCalls.find((c) => c.command === 'Page.captureScreenshot');
    expect(shot).toBeDefined();
    expect(shot!.params).toEqual({ format: 'png', captureBeyondViewport: true });
    // page.screenshot fallback was bypassed on the screenshot step
    // because CDP was available.
    expect(log.some((c) => c.name === 'page.screenshot')).toBe(false);

    writeFileSpy.mockRestore();
  });
});
