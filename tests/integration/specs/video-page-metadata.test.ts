/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// End-to-end coverage for the fixture's video-page capture and the
// reporter's positional join with `result.attachments`.
//
// What this test pins that unit tests cannot:
//
//   - Playwright's real rename of the video file between fixture
//     teardown (recording-time `<hash>.webm`) and reporter
//     `onTestEnd` (final `video.webm`). The earlier path-based join
//     bug went undetected by unit tests because they mocked
//     `result.attachments[i].path` to match the fixture-captured
//     path; only a real Playwright run reproduces the mismatch.
//
//   - That `result.attachments` actually contains a video entry
//     for a single-page test in headless Chromium with `video: 'on'`.
//
//   - That `pageName: 'main'` + a non-empty `pageUrl` land on disk
//     in the per-test `heal-traces.ndjson`'s `test-attachments`
//     record, exactly as the schema documents.

import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { IntegrationSandbox } from '../bootstrap/integration-sandbox';
import type {
  TestAttachment,
  TestAttachmentsRecord,
} from '../../../src/domain/trace-event-recorder/model/statement-trace-schema';

// One-test spec — the fixture's video-page capture runs in the
// finally block of `_traceAuto`, so any test body that navigates is
// enough; we don't need clicks or assertions.
const SPEC = `import { test } from '@playwright/test';

const base = process.env.INTEGRATION_BASE_URL as string;

test('records a video for the main page', async ({ page }) => {
  await page.goto(base + '/');
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

/**
 * Find the per-test `heal-traces.ndjson` produced by the run.
 * Single test in the spec, so we walk `heal-traces/**` once and
 * return the only file — failing loudly if zero or many surface.
 */
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
    if (parsed.kind === 'test-attachments') {
      return parsed as TestAttachmentsRecord;
    }
  }
  throw new Error(`no test-attachments record in ${ndjsonPath}`);
}

describe('integration: video page metadata in test-attachments', () => {
  it('stamps pageName="main" and a real pageUrl on the video attachment', () => {
    const ndjsonPath = findNdjson();
    const record = readTestAttachments(ndjsonPath);

    const videoAttachments = record.attachments.filter((a: TestAttachment) =>
      a.contentType.toLowerCase().startsWith('video/'),
    );
    expect(videoAttachments).toHaveLength(1);

    const video = videoAttachments[0];
    expect(video.pageName).toBe('main');
    // pageUrl comes from `page.url()` at fixture teardown, which by
    // then is the integration base URL the spec navigated to.
    expect(typeof video.pageUrl).toBe('string');
    expect(video.pageUrl?.startsWith('http')).toBe(true);
  });

  it('does not stamp pageName/pageUrl on non-video attachments', () => {
    const ndjsonPath = findNdjson();
    const record = readTestAttachments(ndjsonPath);
    const nonVideo = record.attachments.filter(
      (a: TestAttachment) => !a.contentType.toLowerCase().startsWith('video/'),
    );
    for (const att of nonVideo) {
      expect(att.pageName).toBeUndefined();
      expect(att.pageUrl).toBeUndefined();
    }
  });
});
