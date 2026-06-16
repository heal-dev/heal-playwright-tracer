/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Auto-captures manual-context videos at fixture teardown.
//
// The reporter only copies videos present in `result.attachments`;
// Playwright attaches the built-in `page` video but NOT a
// `browser.newContext` one. So for every non-primary page we finalize
// its context (close it if the test left it open, so the video
// flushes), await the recording path, and attach the file ourselves —
// unless the test already attached it. This lands manual-context videos
// in heal-traces with no per-test `testInfo.attach`.
//
// Extracted from the fixture's teardown closure so the branchy logic
// (which contexts to close, the bounded path drain, and the
// skip-already-attached / skip-missing-file paths) is unit-testable
// without driving a full Playwright run. Best-effort throughout: any
// failure just leaves a video un-attached and the run continues.

import * as fs from 'fs';
import type { Page } from 'playwright';
import type { PageEntry } from '../../infrastructure/playwright-page-registry-adapter';
import { withTimeout } from '../../util/with-timeout';
import { log } from '../../util/logger';

export interface AutoAttachManualVideosDeps {
  /** `testInfo.attach` bound to the running test. */
  attach: (name: string, options: { path: string; contentType: string }) => Promise<unknown>;
  /** Bound on the path-drain so a never-settling live page can't wedge teardown. */
  timeoutMs: number;
  /** Existence check, injectable for tests. Defaults to `fs.existsSync`. */
  fileExists?: (p: string) => boolean;
}

/**
 * @param entries        Every page the registry saw (`pageRegistry.list()`).
 * @param primaryPage    The test's built-in `page` (its context is closed by
 *                       Playwright, and its video is auto-attached — skip it).
 * @param videoAttachMap recordingPath → final attachment path, captured by
 *                       intercepting `testInfo.attach`. A hit means the test
 *                       already attached that video, so we must not re-attach.
 */
export async function autoAttachManualVideos(
  entries: PageEntry[],
  primaryPage: Page,
  videoAttachMap: Map<string, string>,
  deps: AutoAttachManualVideosDeps,
): Promise<void> {
  const fileExists = deps.fileExists ?? fs.existsSync;
  try {
    const manualEntries = entries.filter((e) => e.page !== primaryPage);
    let primaryCtx: unknown;
    try {
      primaryCtx = primaryPage.context();
    } catch {
      primaryCtx = undefined;
    }
    // (a) Finalize still-open non-primary contexts so their videos flush.
    const ctxToClose = new Set<{ close: () => Promise<void> }>();
    for (const e of manualEntries) {
      try {
        const ctx = e.page.context() as unknown as { close: () => Promise<void> };
        if (ctx && ctx !== primaryCtx) ctxToClose.add(ctx);
      } catch {
        // page/context already gone — its path promise has settled.
      }
    }
    for (const ctx of ctxToClose) {
      try {
        await ctx.close();
      } catch {
        // already closed / detached — ignore.
      }
    }
    // (b) Await resolved recording paths (bounded — a live page never settles).
    try {
      await withTimeout(
        Promise.allSettled(
          manualEntries
            .map((e) => e.videoPathPromise)
            .filter((p): p is Promise<string | null> => !!p),
        ),
        deps.timeoutMs,
        'manual-video path drain',
      );
    } catch {
      // timed out — attach whatever resolved.
    }
    // (c) Attach each manual video the test did not attach itself.
    for (const e of manualEntries) {
      const rec = e.videoRecordingPath;
      if (!rec || videoAttachMap.has(rec)) continue;
      try {
        if (!fileExists(rec)) continue;
        await deps.attach(`page-video-${e.pageId.replace(/\//g, '-')}`, {
          path: rec,
          contentType: 'video/webm',
        });
      } catch (err) {
        log.warn('auto-attach of manual-context video failed', err);
      }
    }
  } catch (err) {
    log.error('manual-context video auto-capture failed', err);
  }
}
