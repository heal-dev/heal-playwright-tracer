/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// End-to-end coverage for page attribution across MULTIPLE contexts —
// the `withRecordedContext` shape from heal-stories-heal.
//
// The spec records two videos: the built-in `page` context (auto-
// attached and renamed by Playwright) and a manually-created context
// (recordVideo + an explicit `testInfo.attach('video', …)`, closed
// mid-body). What this pins that unit tests cannot:
//
//   - The fixture registers the manual context (via the always-on
//     wireAllPages registry hook) and resolves its video path on close.
//   - The reporter matches the manual video to its page BY PATH and
//     falls back to positional pairing for the renamed built-in video.
//   - Each video attachment ends up with a distinct `pageId`
//     (`ctx0/p0` for the built-in page, a different `ctx*/p0` for the
//     manual context) plus a `videoStartWallMs` anchor.

import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { IntegrationSandbox } from '../bootstrap/integration-sandbox';
import type {
  TestAttachment,
  TestAttachmentsRecord,
} from '../../../src/domain/trace-event-recorder/model/statement-trace-schema';

const SPEC = `import { test } from '@playwright/test';

const base = process.env.INTEGRATION_BASE_URL as string;

test('records videos for the built-in and a manual context', async ({ page, browser }, testInfo) => {
  // Built-in context page (video: 'on' in config → auto-attached).
  await page.goto(base + '/');

  // Manually-created context that records its own video and attaches
  // it itself — mirrors withRecordedContext in heal-stories-heal.
  const ctx = await browser.newContext({ recordVideo: { dir: testInfo.outputDir } });
  const p2 = await ctx.newPage();
  await p2.goto(base + '/');
  const video = p2.video();
  await ctx.close();
  if (video) {
    await testInfo.attach('video', { path: await video.path(), contentType: 'video/webm' });
  }
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

describe('integration: multi-context video page attribution', () => {
  it('labels each video with a distinct pageId + a videoStartWallMs anchor', () => {
    const record = readTestAttachments(findNdjson());
    const videos = record.attachments.filter((a: TestAttachment) =>
      a.contentType.toLowerCase().startsWith('video/'),
    );
    // One built-in + one manual = two videos.
    expect(videos.length).toBe(2);

    // Every video is attributed to a page and carries an anchor.
    for (const v of videos) {
      expect(v.pageId).toMatch(/^ctx\d+\/p\d+$/);
      expect(typeof v.videoStartWallMs).toBe('number');
      expect(v.videoStartWallMs).toBeGreaterThan(0);
    }

    // The built-in page is the registry's primary page (ctx0/p0); the
    // manual context is a different context, so the two pageIds differ.
    const pageIds = videos.map((v) => v.pageId);
    expect(pageIds).toContain('ctx0/p0');
    expect(new Set(pageIds).size).toBe(2);
  });
});
