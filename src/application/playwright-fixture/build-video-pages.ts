/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Builds the `videoPages` list the fixture writes into the pending
// registry at teardown — the per-page identity the reporter joins to
// `result.attachments` video entries. Extracted from the fixture's
// teardown closure so the branchy logic (which pages to emit, the
// recording-path → final-path join, role labelling, and the
// closed-page error paths) is unit-testable without driving a full
// Playwright run.

import type { Page } from 'playwright';
import type { PageEntry } from '../../infrastructure/playwright-page-registry-adapter';
import type { VideoPageInfo } from '../../infrastructure/heal-reporter';

/**
 * @param entries        Every page the registry saw, in creation order
 *                       (`pageRegistry.list()`).
 * @param primaryPage    The test's built-in `page`, labelled `'main'`. Other
 *                       pages are `page-n`; Electron windows `window-n`.
 * @param videoAttachMap recordingPath → final attachment path, captured
 *                       by intercepting `testInfo.attach` (manual videos).
 */
export function buildVideoPages(
  entries: PageEntry[],
  primaryPage: Page,
  videoAttachMap: Map<string, string>,
): VideoPageInfo[] {
  const videoPages: VideoPageInfo[] = [];
  let otherIndex = 0;
  let windowIndex = 0;
  const labelFor = (entry: PageEntry): string => {
    if (entry.page === primaryPage) return 'main';
    if (entry.kind === 'electron') return `window-${(windowIndex += 1)}`;
    return `page-${(otherIndex += 1)}`;
  };
  for (const entry of entries) {
    const p = entry.page;
    let hasVideo = false;
    try {
      hasVideo = !!p.video();
    } catch {
      hasVideo = false; // page/context already gone
    }
    // Final attachment path of a video this test attached itself
    // (manual context), if any — the reporter matches by it.
    const videoPath = entry.videoRecordingPath
      ? videoAttachMap.get(entry.videoRecordingPath)
      : undefined;
    // Emit a page only if it has a live video (built-in, positional) or
    // an attached one (manual, path-matched). A recorded-but-unattached
    // video produces no attachment, so it must not claim a positional slot.
    if (!hasVideo && !videoPath) continue;
    // An Electron window's video is always attached by path (by the
    // fixture, or by the test itself) — never positionally. One whose
    // recording was removed (video mode not met) still answers `video()`,
    // and must not claim a slot it can never fill.
    if (entry.kind === 'electron' && !videoPath) continue;
    let url = '';
    try {
      url = p.url();
    } catch {
      url = '';
    }
    videoPages.push({
      name: labelFor(entry),
      url,
      pageId: entry.pageId,
      videoStartWallMs: entry.videoStartWallMs,
      ...(videoPath ? { videoPath } : {}),
    });
  }
  return videoPages;
}
