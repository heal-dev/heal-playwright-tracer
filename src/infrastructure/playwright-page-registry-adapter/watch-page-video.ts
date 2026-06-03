/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Resolves a page's recorded-video path and stores it on the registry
// so the reporter can map a video attachment back to its page id.
//
// Playwright's `Video.path()` only settles once the page (or its
// context) closes. We grab the Video handle while the page is still
// open (at registration) and subscribe to the page's `close` event to
// resolve the final path then. For manually-created contexts that a
// test closes itself mid-body, this resolves well before the fixture's
// teardown reads it; for the built-in context (closed by Playwright
// after our fixture), it never resolves and the reporter falls back to
// positional pairing — which is the only option there anyway, since
// Playwright renames that video after teardown.
//
// Best-effort throughout: a page without `video()` (recordVideo off)
// or a path that never resolves simply leaves the entry path-less.

import type { Page } from 'playwright';
import type { PageRegistry } from './page-registry';
import { log } from '../../util/logger';

export function watchPageVideo(registry: PageRegistry, page: Page): void {
  // Duck-type: a real Page exposes video() and on(); unit-test page
  // doubles generally do not, so bail quietly.
  const getVideo = (page as { video?: () => unknown }).video;
  const on = (page as { on?: (event: string, cb: () => void) => void }).on;
  if (typeof getVideo !== 'function' || typeof on !== 'function') return;

  let video: { path?: () => Promise<string> } | null;
  try {
    video = getVideo.call(page) as { path?: () => Promise<string> } | null;
  } catch {
    return; // recordVideo off / page already gone
  }
  if (!video || typeof video.path !== 'function') return;
  const resolvePath = video.path.bind(video);

  on.call(page, 'close', () => {
    Promise.resolve(resolvePath()).then(
      (resolved) => registry.setVideoRecordingPath(page, resolved),
      (err) => log.warn('video.path() did not resolve after page close', err),
    );
  });
}
