/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect } from 'vitest';
import type { Page } from 'playwright';
import { buildVideoPages } from '../../../src/application/playwright-fixture/build-video-pages';
import type { PageEntry } from '../../../src/infrastructure/playwright-page-registry-adapter';

// Minimal Page double: video() / url() can be made to return values or
// to throw (closed page). `hasVideo` controls whether video() yields a
// truthy handle.
function makePage(opts: { hasVideo?: boolean; url?: string; throwOnVideo?: boolean } = {}): Page {
  return {
    video: () => {
      if (opts.throwOnVideo) throw new Error('target page/context has been closed');
      return opts.hasVideo ? ({} as unknown) : null;
    },
    url: () => {
      if (opts.url === undefined) throw new Error('page closed');
      return opts.url;
    },
  } as unknown as Page;
}

function entry(page: Page, over: Partial<PageEntry> = {}): PageEntry {
  return {
    pageId: 'ctx0/p0',
    page,
    videoStartWallMs: 1000,
    ...over,
  };
}

describe('buildVideoPages', () => {
  it('labels the primary page "main" and others page-1, page-2 …', () => {
    const primary = makePage({ hasVideo: true, url: 'https://app.test/home' });
    const p1 = makePage({ hasVideo: true, url: 'https://app.test/popup' });
    const p2 = makePage({ hasVideo: true, url: 'https://app.test/third' });
    const out = buildVideoPages(
      [
        entry(primary, { pageId: 'ctx0/p0', videoStartWallMs: 1000 }),
        entry(p1, { pageId: 'ctx0/p1', videoStartWallMs: 1100 }),
        entry(p2, { pageId: 'ctx1/p0', videoStartWallMs: 1200 }),
      ],
      primary,
      new Map(),
    );
    expect(out.map((v) => v.name)).toEqual(['main', 'page-1', 'page-2']);
    expect(out.map((v) => v.pageId)).toEqual(['ctx0/p0', 'ctx0/p1', 'ctx1/p0']);
    expect(out.map((v) => v.videoStartWallMs)).toEqual([1000, 1100, 1200]);
  });

  it('skips pages with neither a live video nor an attached recording', () => {
    const primary = makePage({ hasVideo: true, url: 'https://app.test/' });
    const noVideo = makePage({ hasVideo: false, url: 'https://app.test/x' });
    const out = buildVideoPages(
      [entry(primary), entry(noVideo, { pageId: 'ctx0/p1' })],
      primary,
      new Map(),
    );
    expect(out.map((v) => v.pageId)).toEqual(['ctx0/p0']);
    // The skipped page must not consume a positional slot.
    expect(out).toHaveLength(1);
  });

  it('joins a closed manual page to its final attachment path via the attach map', () => {
    const primary = makePage({ hasVideo: true, url: 'https://app.test/' });
    // Manual page: context closed → video() throws, but it recorded and
    // its recording path was captured.
    const manual = makePage({ throwOnVideo: true, url: 'https://role.test/op' });
    const attachMap = new Map([['/rec/page@abc.webm', '/out/video-deadbeef.webm']]);
    const out = buildVideoPages(
      [
        entry(primary, { pageId: 'ctx0/p0' }),
        entry(manual, { pageId: 'ctx1/p0', videoRecordingPath: '/rec/page@abc.webm' }),
      ],
      primary,
      attachMap,
    );
    const manualEntry = out.find((v) => v.pageId === 'ctx1/p0');
    expect(manualEntry?.videoPath).toBe('/out/video-deadbeef.webm');
    expect(manualEntry?.name).toBe('page-1');
  });

  it('omits videoPath when a recorded page was never attached (no map hit)', () => {
    const primary = makePage({ hasVideo: true, url: 'https://app.test/' });
    const manual = makePage({ throwOnVideo: true, url: 'https://role.test/op' });
    // recordingPath set but NOT in the attach map → no attachment exists,
    // and video() throws → the page is skipped entirely.
    const out = buildVideoPages(
      [
        entry(primary, { pageId: 'ctx0/p0' }),
        entry(manual, { pageId: 'ctx1/p0', videoRecordingPath: '/rec/unattached.webm' }),
      ],
      primary,
      new Map(),
    );
    expect(out.map((v) => v.pageId)).toEqual(['ctx0/p0']);
  });

  it('tolerates a page whose url() throws (closed) → empty url, entry still emitted via videoPath', () => {
    const primary = makePage({ hasVideo: true, url: 'https://app.test/' });
    const manual = makePage({ throwOnVideo: true }); // url() throws too
    const out = buildVideoPages(
      [
        entry(primary, { pageId: 'ctx0/p0' }),
        entry(manual, { pageId: 'ctx1/p0', videoRecordingPath: '/rec/x.webm' }),
      ],
      primary,
      new Map([['/rec/x.webm', '/out/v.webm']]),
    );
    const manualEntry = out.find((v) => v.pageId === 'ctx1/p0');
    expect(manualEntry).toBeDefined();
    expect(manualEntry?.url).toBe('');
    expect(manualEntry?.videoPath).toBe('/out/v.webm');
  });

  it('returns an empty list when no page recorded a video', () => {
    const primary = makePage({ hasVideo: false, url: 'https://app.test/' });
    expect(buildVideoPages([entry(primary)], primary, new Map())).toEqual([]);
  });
});
