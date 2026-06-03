/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect } from 'vitest';
import {
  patchTestInfoAttach,
  type AttachableTestInfo,
} from '../../../src/infrastructure/playwright-page-registry-adapter';

// A TestInfo double whose attach() mimics Playwright: it copies the
// given path to a content-hashed name and pushes an attachment whose
// `path` is that final (different) path.
function makeTestInfo(): AttachableTestInfo & { calls: number } {
  const attachments: Array<{ path?: string; contentType?: string }> = [];
  return {
    attachments,
    calls: 0,
    async attach(name, options) {
      (this as { calls: number }).calls++;
      const finalPath =
        options?.path !== undefined
          ? `/out/attachments/${name}-deadbeef.webm`
          : '/out/attachments/inline';
      attachments.push({ path: finalPath, contentType: options?.contentType });
    },
  };
}

describe('patchTestInfoAttach', () => {
  it('reports (recordingPath → finalPath) for a video attached by path', async () => {
    const testInfo = makeTestInfo();
    const seen: Array<[string, string]> = [];
    patchTestInfoAttach(testInfo, (rec, fin) => seen.push([rec, fin]));

    await testInfo.attach('video', {
      path: '/tmp/rec/page@abc.webm',
      contentType: 'video/webm',
    });

    expect(seen).toEqual([['/tmp/rec/page@abc.webm', '/out/attachments/video-deadbeef.webm']]);
    expect(testInfo.calls).toBe(1); // original still invoked
  });

  it('infers video content type from the pushed attachment when not declared', async () => {
    const testInfo = makeTestInfo();
    const seen: Array<[string, string]> = [];
    // attach() double records contentType from options; emulate the
    // attachment carrying the type even if the caller omitted it.
    const original = testInfo.attach.bind(testInfo);
    testInfo.attach = async (name, options) => {
      await original(name, options);
      testInfo.attachments[testInfo.attachments.length - 1].contentType = 'video/webm';
    };
    patchTestInfoAttach(testInfo, (rec, fin) => seen.push([rec, fin]));

    await testInfo.attach('video', { path: '/tmp/rec/x.webm' });
    expect(seen).toHaveLength(1);
  });

  it('ignores non-video attachments', async () => {
    const testInfo = makeTestInfo();
    const seen: Array<[string, string]> = [];
    patchTestInfoAttach(testInfo, (rec, fin) => seen.push([rec, fin]));

    await testInfo.attach('screenshot', {
      path: '/tmp/shot.png',
      contentType: 'image/png',
    });
    expect(seen).toEqual([]);
  });

  it('ignores body-only attachments (no path)', async () => {
    const testInfo = makeTestInfo();
    const seen: Array<[string, string]> = [];
    patchTestInfoAttach(testInfo, (rec, fin) => seen.push([rec, fin]));

    await testInfo.attach('log', { body: 'hello', contentType: 'video/webm' });
    expect(seen).toEqual([]);
  });

  it('the disposer restores the original attach', async () => {
    const testInfo = makeTestInfo();
    const original = testInfo.attach;
    const restore = patchTestInfoAttach(testInfo, () => {});
    expect(testInfo.attach).not.toBe(original);
    restore();
    expect(testInfo.attach).toBe(original);
  });
});
