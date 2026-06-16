/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect, vi } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import { autoAttachManualVideos } from '../../../src/application/playwright-fixture/auto-attach-manual-videos';
import type { PageEntry } from '../../../src/infrastructure/playwright-page-registry-adapter';

// A Page double exposing just context(). `closeThrows` makes context()
// throw (page already gone); otherwise context() returns the given ctx.
function makePage(ctx?: BrowserContext, opts: { contextThrows?: boolean } = {}): Page {
  return {
    context: () => {
      if (opts.contextThrows) throw new Error('target page has been closed');
      return ctx ?? ({} as BrowserContext);
    },
  } as unknown as Page;
}

// A BrowserContext double whose close() is a spy.
function makeContext(): BrowserContext & { close: ReturnType<typeof vi.fn> } {
  return { close: vi.fn().mockResolvedValue(undefined) } as unknown as BrowserContext & {
    close: ReturnType<typeof vi.fn>;
  };
}

function entry(over: Partial<PageEntry> & Pick<PageEntry, 'page'>): PageEntry {
  return {
    pageId: 'ctx1/p0',
    videoStartWallMs: 1000,
    ...over,
  };
}

// A no-op attach spy that records its calls. Typed to the deps.attach
// signature so it slots in without a cast.
function makeAttach() {
  return vi.fn(
    async (_name: string, _options: { path: string; contentType: string }): Promise<unknown> =>
      undefined,
  );
}

const ALWAYS = () => true;

describe('autoAttachManualVideos', () => {
  it('attaches a manual video the test did not attach itself', async () => {
    const primaryCtx = makeContext();
    const primary = makePage(primaryCtx);
    const manualCtx = makeContext();
    const manual = makePage(manualCtx);
    const attach = makeAttach();

    await autoAttachManualVideos(
      [
        entry({ page: primary, pageId: 'ctx0/p0' }),
        entry({ page: manual, pageId: 'ctx1/p0', videoRecordingPath: '/rec/manual.webm' }),
      ],
      primary,
      new Map(),
      { attach, timeoutMs: 1000, fileExists: ALWAYS },
    );

    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith('page-video-ctx1-p0', {
      path: '/rec/manual.webm',
      contentType: 'video/webm',
    });
  });

  it('never attaches the primary page video (Playwright already did)', async () => {
    const ctx = makeContext();
    const primary = makePage(ctx);
    const attach = makeAttach();

    await autoAttachManualVideos(
      [entry({ page: primary, pageId: 'ctx0/p0', videoRecordingPath: '/rec/primary.webm' })],
      primary,
      new Map(),
      { attach, timeoutMs: 1000, fileExists: ALWAYS },
    );

    expect(attach).not.toHaveBeenCalled();
    // The primary context must not be closed by us.
    expect(ctx.close).not.toHaveBeenCalled();
  });

  it('skips a video the test already attached itself (recordingPath in the attach map)', async () => {
    const primary = makePage(makeContext());
    const manual = makePage(makeContext());
    const attach = makeAttach();

    await autoAttachManualVideos(
      [
        entry({ page: primary, pageId: 'ctx0/p0' }),
        entry({ page: manual, pageId: 'ctx1/p0', videoRecordingPath: '/rec/manual.webm' }),
      ],
      primary,
      new Map([['/rec/manual.webm', '/out/video-hash.webm']]),
      { attach, timeoutMs: 1000, fileExists: ALWAYS },
    );

    expect(attach).not.toHaveBeenCalled();
  });

  it('skips an entry with no resolved recording path', async () => {
    const primary = makePage(makeContext());
    const manual = makePage(makeContext()); // videoRecordingPath undefined
    const attach = makeAttach();

    await autoAttachManualVideos(
      [entry({ page: primary, pageId: 'ctx0/p0' }), entry({ page: manual, pageId: 'ctx1/p0' })],
      primary,
      new Map(),
      { attach, timeoutMs: 1000, fileExists: ALWAYS },
    );

    expect(attach).not.toHaveBeenCalled();
  });

  it('skips a recording path whose file is missing on disk', async () => {
    const primary = makePage(makeContext());
    const manual = makePage(makeContext());
    const attach = makeAttach();

    await autoAttachManualVideos(
      [
        entry({ page: primary, pageId: 'ctx0/p0' }),
        entry({ page: manual, pageId: 'ctx1/p0', videoRecordingPath: '/rec/gone.webm' }),
      ],
      primary,
      new Map(),
      { attach, timeoutMs: 1000, fileExists: () => false },
    );

    expect(attach).not.toHaveBeenCalled();
  });

  it('closes a still-open non-primary context so its video flushes', async () => {
    const primaryCtx = makeContext();
    const primary = makePage(primaryCtx);
    const manualCtx = makeContext();
    const manual = makePage(manualCtx);

    await autoAttachManualVideos(
      [
        entry({ page: primary, pageId: 'ctx0/p0' }),
        entry({ page: manual, pageId: 'ctx1/p0', videoRecordingPath: '/rec/manual.webm' }),
      ],
      primary,
      new Map(),
      { attach: makeAttach(), timeoutMs: 1000, fileExists: ALWAYS },
    );

    expect(manualCtx.close).toHaveBeenCalledTimes(1);
    // The primary context is never closed here — Playwright owns it.
    expect(primaryCtx.close).not.toHaveBeenCalled();
  });

  it('closes each distinct context only once (two pages sharing one context)', async () => {
    const primary = makePage(makeContext());
    const sharedCtx = makeContext();
    const a = makePage(sharedCtx);
    const b = makePage(sharedCtx);

    await autoAttachManualVideos(
      [
        entry({ page: primary, pageId: 'ctx0/p0' }),
        entry({ page: a, pageId: 'ctx1/p0', videoRecordingPath: '/rec/a.webm' }),
        entry({ page: b, pageId: 'ctx1/p1', videoRecordingPath: '/rec/b.webm' }),
      ],
      primary,
      new Map(),
      { attach: makeAttach(), timeoutMs: 1000, fileExists: ALWAYS },
    );

    expect(sharedCtx.close).toHaveBeenCalledTimes(1);
  });

  it('does not close a context already closed by the test (context() throws)', async () => {
    const primary = makePage(makeContext());
    // Page whose context() throws — the test closed it mid-body.
    const closed = makePage(undefined, { contextThrows: true });
    const attach = makeAttach();

    await autoAttachManualVideos(
      [
        entry({ page: primary, pageId: 'ctx0/p0' }),
        entry({
          page: closed,
          pageId: 'ctx1/p0',
          videoRecordingPath: '/rec/closed.webm',
          // its path promise already settled before teardown
          videoPathPromise: Promise.resolve('/rec/closed.webm'),
        }),
      ],
      primary,
      new Map(),
      { attach, timeoutMs: 1000, fileExists: ALWAYS },
    );

    // Even though we couldn't (re)close it, the resolved recording still attaches.
    expect(attach).toHaveBeenCalledWith('page-video-ctx1-p0', {
      path: '/rec/closed.webm',
      contentType: 'video/webm',
    });
  });

  it('awaits each entry videoPathPromise before attaching', async () => {
    const primary = makePage(makeContext());
    const manualCtx = makeContext();
    const manual = makePage(manualCtx);
    let resolved = false;
    const pathPromise = new Promise<string | null>((resolve) =>
      setTimeout(() => {
        resolved = true;
        resolve('/rec/manual.webm');
      }, 5),
    );
    const attach = vi.fn(
      async (_name: string, _options: { path: string; contentType: string }): Promise<unknown> => {
        // The drain must have completed before we get here.
        expect(resolved).toBe(true);
        return undefined;
      },
    );

    await autoAttachManualVideos(
      [
        entry({ page: primary, pageId: 'ctx0/p0' }),
        entry({
          page: manual,
          pageId: 'ctx1/p0',
          videoRecordingPath: '/rec/manual.webm',
          videoPathPromise: pathPromise,
        }),
      ],
      primary,
      new Map(),
      { attach, timeoutMs: 1000, fileExists: ALWAYS },
    );

    expect(attach).toHaveBeenCalledTimes(1);
  });

  it('still attaches resolved videos when the path drain times out', async () => {
    const primary = makePage(makeContext());
    const manual = makePage(makeContext());
    const attach = makeAttach();
    // A promise that never settles → drain hits the timeout.
    const neverSettles = new Promise<string | null>(() => {});

    await autoAttachManualVideos(
      [
        entry({ page: primary, pageId: 'ctx0/p0' }),
        entry({
          page: manual,
          pageId: 'ctx1/p0',
          videoRecordingPath: '/rec/manual.webm',
          videoPathPromise: neverSettles,
        }),
      ],
      primary,
      new Map(),
      { attach, timeoutMs: 10, fileExists: ALWAYS },
    );

    expect(attach).toHaveBeenCalledWith('page-video-ctx1-p0', {
      path: '/rec/manual.webm',
      contentType: 'video/webm',
    });
  });

  it('swallows a context close() rejection and still attaches', async () => {
    const primary = makePage(makeContext());
    const manualCtx = makeContext();
    manualCtx.close.mockRejectedValue(new Error('already detached'));
    const manual = makePage(manualCtx);
    const attach = makeAttach();

    await expect(
      autoAttachManualVideos(
        [
          entry({ page: primary, pageId: 'ctx0/p0' }),
          entry({ page: manual, pageId: 'ctx1/p0', videoRecordingPath: '/rec/manual.webm' }),
        ],
        primary,
        new Map(),
        { attach, timeoutMs: 1000, fileExists: ALWAYS },
      ),
    ).resolves.toBeUndefined();

    expect(attach).toHaveBeenCalledTimes(1);
  });

  it('swallows an attach() rejection without throwing', async () => {
    const primary = makePage(makeContext());
    const manual = makePage(makeContext());
    const attach = vi.fn(
      async (_name: string, _options: { path: string; contentType: string }): Promise<unknown> => {
        throw new Error('attach blew up');
      },
    );

    await expect(
      autoAttachManualVideos(
        [
          entry({ page: primary, pageId: 'ctx0/p0' }),
          entry({ page: manual, pageId: 'ctx1/p0', videoRecordingPath: '/rec/manual.webm' }),
        ],
        primary,
        new Map(),
        { attach, timeoutMs: 1000, fileExists: ALWAYS },
      ),
    ).resolves.toBeUndefined();
  });

  it('replaces slashes in the pageId when naming the attachment', async () => {
    const primary = makePage(makeContext());
    const manual = makePage(makeContext());
    const attach = makeAttach();

    await autoAttachManualVideos(
      [
        entry({ page: primary, pageId: 'ctx0/p0' }),
        entry({ page: manual, pageId: 'ctx2/p3', videoRecordingPath: '/rec/m.webm' }),
      ],
      primary,
      new Map(),
      { attach, timeoutMs: 1000, fileExists: ALWAYS },
    );

    expect(attach).toHaveBeenCalledWith('page-video-ctx2-p3', expect.anything());
  });
});
