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
// An Electron window (entry `kind: 'electron'`) takes the same path —
// Playwright's `ElectronApplication.close()` is its context's close —
// with two differences: its video is attached under the name `video`
// (the name a viewer picks first), and it is kept or removed by the
// video mode the fixture resolved for Electron (`keepVideo`). A context
// the host owns (`owned: false`, registered by hand) is left alone:
// neither closed nor attached.
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
  /**
   * Bound on each context close and on the path drain, so a hanging
   * close (an Electron app with a stuck quit handler) or a
   * never-settling live page can't wedge teardown.
   */
  timeoutMs: number;
  /** Existence check, injectable for tests. Defaults to `fs.existsSync`. */
  fileExists?: (p: string) => boolean;
  /**
   * Whether a resolved recording is attached (true) or removed (false).
   * Defaults to keeping everything; the fixture passes the video mode
   * rule for Electron windows.
   */
  keepVideo?: (entry: PageEntry) => boolean;
  /** File removal for a recording not kept. Defaults to a forced `fs.rmSync`. */
  removeFile?: (p: string) => void;
}

const attachmentNameFor = (entry: PageEntry): string =>
  entry.kind === 'electron' ? 'video' : `page-video-${entry.pageId.replace(/\//g, '-')}`;

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
  const keepVideo = deps.keepVideo ?? (() => true);
  const removeFile = deps.removeFile ?? ((p: string) => fs.rmSync(p, { force: true }));
  try {
    // A context the host owns (`owned: false`) is not ours to close,
    // and its video is not ours to attach.
    const manualEntries = entries.filter((e) => e.page !== primaryPage && e.owned !== false);
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
        await withTimeout(ctx.close(), deps.timeoutMs, 'context.close');
      } catch {
        // already closed / detached / hung past the bound — ignore.
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
    // (c) Attach each manual video the test did not attach itself —
    //     or remove it when the video mode says it is not kept.
    for (const e of manualEntries) {
      const rec = e.videoRecordingPath;
      if (!rec || videoAttachMap.has(rec)) continue;
      try {
        if (!fileExists(rec)) continue;
        if (!keepVideo(e)) {
          removeFile(rec);
          continue;
        }
        await deps.attach(attachmentNameFor(e), {
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
