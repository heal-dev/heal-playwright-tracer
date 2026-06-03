/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Intercepts `testInfo.attach` for one test to learn the FINAL path of
// each video a test attaches itself (the `withRecordedContext` shape:
// `testInfo.attach('video', { path: await video.path() })`).
//
// Why this is needed: Playwright copies a file passed to
// `testInfo.attach({ path })` into a content-hashed name
// (`video-<sha1>.webm`) and the attachment — and therefore the
// reporter — references that copy, not the recording path the test
// passed. So the recording path the registry captured on page-close
// can't be matched against the reporter's attachment path directly.
//
// The wrapper calls through to the original, then reads the freshly
// added attachment's final `path` and reports the
// `(recordingPath → finalPath)` pair. The fixture joins that to the
// page registry at teardown (race-free: both the page-close path and
// the attach happen during the test body), yielding finalPath → pageId
// for the reporter.

export interface AttachableTestInfo {
  attach: (
    name: string,
    options?: { path?: string; body?: string | Buffer; contentType?: string },
  ) => Promise<void>;
  attachments: ReadonlyArray<{ path?: string; contentType?: string }>;
}

export type OnVideoAttached = (recordingPath: string, finalPath: string) => void;

/**
 * Patch `testInfo.attach`. Returns a disposer that restores the
 * original. Best-effort: never lets bookkeeping break the user's
 * attach call.
 */
export function patchTestInfoAttach(
  testInfo: AttachableTestInfo,
  onVideoAttached: OnVideoAttached,
): () => void {
  const original = testInfo.attach;
  if (typeof original !== 'function') return () => {};
  const bound = original.bind(testInfo);

  testInfo.attach = async (name, options) => {
    const result = await bound(name, options);
    try {
      const recordingPath = options?.path;
      const declaredType = options?.contentType ?? '';
      const attachments = testInfo.attachments ?? [];
      const last = attachments[attachments.length - 1];
      const contentType = declaredType || last?.contentType || '';
      if (
        typeof recordingPath === 'string' &&
        contentType.toLowerCase().startsWith('video/') &&
        last &&
        typeof last.path === 'string' &&
        last.path.length > 0
      ) {
        onVideoAttached(recordingPath, last.path);
      }
    } catch {
      // Bookkeeping must never affect the user's attachment.
    }
    return result;
  };

  return () => {
    testInfo.attach = original;
  };
}
