/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// End-to-end coverage for Electron support, against a REAL Electron:
// a spec launches the fixture app under tests/integration/fixtures/
// electron-app with `_electron.launch()` and never closes it. Before
// this feature the only video of such a test was the built-in Chromium
// page — a white recording of `about:blank` — and the window the test
// drove was never recorded, never captured.
//
// What this pins that unit tests cannot:
//   - The launch patch reaches the `_electron` the spec imports (module
//     identity through `@playwright/test`, rewritten to the tracer).
//   - `recordVideo` is injected, the window is REALLY recorded (the
//     fixture window paints noise, so a real recording is far larger
//     than a blank one), the app is closed by the fixture, and the
//     video is attached under the name `video`, FIRST — before
//     Playwright's built-in one — with `pageName: 'window-1'`.
//   - Statements that drove the window carry its page id, and the
//     window's fetch landed in `heal-network.ndjson`.
//
// Needs an Electron binary (the repo's `electron` devDependency) and a
// display (`xvfb-run` on Linux). Gated on HEAL_IT_ELECTRON=1 so the
// plain integration legs skip it; CI runs it in its own job.

import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { IntegrationSandbox } from '../bootstrap/integration-sandbox';
import type {
  TestAttachment,
  TestAttachmentsRecord,
} from '../../../src/domain/trace-event-recorder/model/statement-trace-schema';

const ELECTRON_MAIN = path.resolve(__dirname, '..', 'fixtures', 'electron-app', 'main.js');

// A recording of 640x480 noise for ~2 s at 25 fps is hundreds of KB;
// a blank one of the same length is under 3 KB.
const REAL_RECORDING_FLOOR_BYTES = 50_000;

// `_electron` comes from `@playwright/test` here on purpose: the tracer's
// code hook rewrites that import to the tracer package, whose
// `export * from '@playwright/test'` must hand back the very object the
// fixture patched. NO app.close() — the fixture must close it.
const SPEC = `import { test, expect, _electron } from '@playwright/test';

test('drives an electron window the tracer must record', async () => {
  const app = await _electron.launch({
    executablePath: process.env.INTEGRATION_ELECTRON_PATH,
    args: [process.env.INTEGRATION_ELECTRON_MAIN],
    env: { ...process.env },
  });
  const win = await app.firstWindow();
  await expect(win.locator('#hello')).toBeVisible({ timeout: 15_000 });
  // The click fires the window's one fetch — after the tracer wired the app.
  await win.locator('#hello').click();
  await expect(win.locator('#status')).toHaveText('fetched', { timeout: 15_000 });
  // Let the recorder bank a couple of seconds of noise.
  await win.waitForTimeout(2000);
});
`;

let sandboxRoot: string;

function findOne(name: string): string {
  const root = path.join(sandboxRoot, 'heal-traces');
  const matches: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === name) matches.push(full);
    }
  };
  walk(root);
  if (matches.length !== 1)
    throw new Error(`expected exactly one ${name}, found ${matches.length}`);
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

describe.skipIf(!process.env.HEAL_IT_ELECTRON)('integration: electron window video', () => {
  beforeAll(async () => {
    const tarballPath = process.env.INTEGRATION_TARBALL;
    if (!tarballPath) throw new Error('INTEGRATION_TARBALL not set — globalSetup failed?');
    // The repo's own Electron binary; the sandbox needs no dependency of its own.
    const electronPath = require('electron') as string;

    const sandbox = new IntegrationSandbox({ tarballPath, specSource: SPEC, withVideo: true });
    sandbox.scaffold();
    sandbox.install();
    await sandbox.runPlaywright({
      INTEGRATION_ELECTRON_PATH: electronPath,
      INTEGRATION_ELECTRON_MAIN: ELECTRON_MAIN,
    });
    sandboxRoot = sandbox.getRoot();
  });

  it('attaches a real recording of the window as the first "video", labelled window-1', () => {
    const ndjson = findOne('heal-traces.ndjson');
    const record = readTestAttachments(ndjson);
    const videos = record.attachments.filter((a: TestAttachment) =>
      a.contentType.toLowerCase().startsWith('video/'),
    );

    // Two recordings: the window (ours, attached at fixture teardown) and
    // the built-in Chromium page (Playwright's, attached after ours).
    expect(videos.length).toBe(2);
    const [win, builtIn] = videos;

    expect(win.name).toBe('video');
    expect(win.pageName).toBe('window-1');
    expect(win.pageId).toMatch(/^ctx[1-9]\d*\/p0$/);
    expect(win.pageUrl).toMatch(/^file:/);
    expect(builtIn.pageName).toBe('main');
    expect(builtIn.pageId).toBe('ctx0/p0');

    // The window's recording is real, not a white frame.
    const file = path.join(path.dirname(ndjson), win.path);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).size).toBeGreaterThan(REAL_RECORDING_FLOOR_BYTES);
  });

  it('attributes the statements that drove the window to its page id', () => {
    const ndjson = findOne('heal-traces.ndjson');
    const record = readTestAttachments(ndjson);
    const win = record.attachments.find((a: TestAttachment) => a.name === 'video');
    const text = fs.readFileSync(ndjson, 'utf8');
    expect(text).toContain(`"pageId":"${win?.pageId}"`);
  });

  it('captured the window fetch in heal-network.ndjson', () => {
    const network = findOne('heal-network.ndjson');
    expect(fs.statSync(network).size).toBeGreaterThan(0);
    expect(fs.readFileSync(network, 'utf8')).toContain('"url":"http://127.0.0.1:');
  });
});

// The shape an Electron-only suite should use: the project's own video
// OFF (the built-in Chromium page never navigates, so its recording is
// blank) and Electron's kept ON through the configureTracer override.
// The window must then be the one and only video.
describe.skipIf(!process.env.HEAL_IT_ELECTRON)(
  'integration: electron window video with the project video off',
  () => {
    let overrideRoot: string;

    beforeAll(async () => {
      const tarballPath = process.env.INTEGRATION_TARBALL;
      if (!tarballPath) throw new Error('INTEGRATION_TARBALL not set — globalSetup failed?');
      const electronPath = require('electron') as string;

      const sandbox = new IntegrationSandbox({
        tarballPath,
        specSource: SPEC,
        withVideo: false,
        withElectronVideo: true,
      });
      sandbox.scaffold();
      sandbox.install();
      await sandbox.runPlaywright({
        INTEGRATION_ELECTRON_PATH: electronPath,
        INTEGRATION_ELECTRON_MAIN: ELECTRON_MAIN,
      });
      overrideRoot = sandbox.getRoot();
    });

    it('records the window alone, as the only "video"', () => {
      const previous = sandboxRoot;
      sandboxRoot = overrideRoot;
      try {
        const ndjson = findOne('heal-traces.ndjson');
        const record = readTestAttachments(ndjson);
        const videos = record.attachments.filter((a: TestAttachment) =>
          a.contentType.toLowerCase().startsWith('video/'),
        );

        expect(videos.length).toBe(1);
        expect(videos[0].name).toBe('video');
        expect(videos[0].pageName).toBe('window-1');
        expect(videos[0].pageUrl).toMatch(/^file:/);
        const file = path.join(path.dirname(ndjson), videos[0].path);
        expect(fs.statSync(file).size).toBeGreaterThan(REAL_RECORDING_FLOOR_BYTES);
      } finally {
        sandboxRoot = previous;
      }
    });
  },
);
