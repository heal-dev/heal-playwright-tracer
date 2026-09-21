/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// End-to-end coverage for the fixture AUTO-ATTACHING a manual
// `browser.newContext` video the test never attached itself.
//
// The reporter only copies videos present in `result.attachments`.
// Playwright auto-attaches the built-in `page` video but NOT a
// `browser.newContext` one, so before this behaviour a manual context's
// video was silently dropped unless the test called `testInfo.attach`
// itself. The fixture now, at teardown, closes any still-open
// non-primary context (flushing its video), awaits the recording path,
// and attaches the file — with ZERO `testInfo.attach` in the spec.
//
// What this pins that unit tests cannot:
//   - The spec contains NO `testInfo.attach`, and crucially LEAVES the
//     manual context OPEN — the fixture must close it for the video to
//     flush, then attach it.
//   - Both videos land in `result.attachments` and the reporter labels
//     each with a distinct `pageId` (`ctx0/p0` for the built-in page,
//     a different `ctx*/p0` for the manual context).

import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { IntegrationSandbox } from '../bootstrap/integration-sandbox';
import type {
  TestAttachment,
  TestAttachmentsRecord,
} from '../../../src/domain/trace-event-recorder/model/statement-trace-schema';

// No `testInfo.attach` anywhere, and the manual context is deliberately
// left OPEN — only the fixture's auto-capture can land its video.
const SPEC = `import { test } from '@playwright/test';

const base = process.env.INTEGRATION_BASE_URL as string;

test('auto-attaches a manual-context video with no testInfo.attach', async ({ page, browser }) => {
  // Built-in context page (video: 'on' in config → auto-attached).
  await page.goto(base + '/');

  // Manually-created context that records its own video. The test never
  // attaches it and never closes it — the fixture must do both.
  const ctx = await browser.newContext({ recordVideo: { dir: test.info().outputDir } });
  const p2 = await ctx.newPage();
  await p2.goto(base + '/');
  // Keep both recordings alive briefly so Playwright reliably flushes a
  // frame to each video — a context that navigates and closes instantly
  // can yield an empty/absent video on some versions (1.50 under load).
  await p2.waitForTimeout(1000);
  await page.waitForTimeout(1000);
  // Intentionally NO ctx.close() and NO testInfo.attach — the fixture
  // closes the context at teardown and attaches the flushed video.
});
`;

let sandboxRoot: string;

beforeAll(async () => {
  const tarballPath = process.env.INTEGRATION_TARBALL;
  if (!tarballPath) throw new Error('INTEGRATION_TARBALL not set — globalSetup failed?');

  const sandbox = new IntegrationSandbox({
    tarballPath,
    specSource: SPEC,
    withVideo: true,
  });
  sandbox.scaffold();
  sandbox.install();
  await sandbox.runPlaywright();
  sandboxRoot = sandbox.getRoot();
});

function findNdjson(): string {
  const root = path.join(sandboxRoot, 'heal-traces');
  const matches: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'heal-traces.ndjson') matches.push(full);
    }
  };
  walk(root);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one heal-traces.ndjson, found ${matches.length}`);
  }
  return matches[0];
}

function readTestAttachments(ndjsonPath: string): TestAttachmentsRecord {
  const lines = fs.readFileSync(ndjsonPath, 'utf8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = JSON.parse(lines[i]) as { kind?: string };
    if (parsed.kind === 'test-attachments') return parsed as TestAttachmentsRecord;
  }
  throw new Error(`no test-attachments record in ${ndjsonPath}`);
}

describe('integration: auto-attach of a manual-context video', () => {
  it('lands the manual-context video with no testInfo.attach, attributed to a distinct page', () => {
    const record = readTestAttachments(findNdjson());
    const videos = record.attachments.filter((a: TestAttachment) =>
      a.contentType.toLowerCase().startsWith('video/'),
    );

    // Two videos must be present: the built-in page (auto-attached by
    // Playwright) and the manual context (auto-attached by the fixture,
    // since the spec attaches nothing). Both recordings are kept alive a
    // full second and the manual context is flushed by the fixture's
    // close, so both reliably carry a frame.
    expect(videos.length).toBe(2);

    // Every video is attributed with a stable pageId + a wall anchor.
    for (const v of videos) {
      expect(v.pageId).toMatch(/^ctx\d+\/p\d+$/);
      expect(typeof v.videoStartWallMs).toBe('number');
      expect(v.videoStartWallMs!).toBeGreaterThan(0);
    }

    const pageIds = videos.map((v) => v.pageId);
    expect(pageIds).toContain('ctx0/p0'); // built-in primary page
    // The manual context is a SECOND, distinct context/page.
    expect(new Set(pageIds).size).toBe(2);
    expect(pageIds.some((id) => id !== 'ctx0/p0')).toBe(true);
  });
});
