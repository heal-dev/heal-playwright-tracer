/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Visual integration test for the screenshot decoration pipeline.
//
// Spins up one sandbox, runs a Playwright spec with six cases, then
// walks every captured PNG and asserts the magenta-border overlay
// landed where the pipeline says it should:
//
//   case                                    | expected outcome
//   ----------------------------------------|--------------------------------
//   1. action click, in-viewport target     | magenta border at known box
//   2. action click, off-viewport target    | scrolled → magenta border, size matches CSS
//   3. toBeVisible, in-viewport target      | magenta border at known box
//   4. toBeVisible, off-viewport target     | scrolled → magenta border, size matches CSS
//   5. toBeInViewport, in-viewport target   | NOT scrolled → magenta border at known box
//   6. not.toBeInViewport, off-viewport     | NOT scrolled → no magenta in PNG
//
// Asserts use region-based pixel sampling (`png-assertions.ts`)
// instead of byte-equal baselines: the page background is white,
// magenta is unique, and we only need to know whether the overlay
// appeared at the right place. Pixel-perfect baselines flake across
// OSes due to antialiasing — sampling doesn't.

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeAll } from 'vitest';
import { IntegrationSandbox } from '../bootstrap/integration-sandbox';
import { DiskTraceReader } from '../bootstrap/test-doubles/disk-trace-reader';
import { walkStatements } from '../fixtures/parsed-trace';
import {
  decodePng,
  expectMagentaBorderAt,
  expectNoMagentaInBox,
  expectViewportSize,
  findMagentaBoundingBox,
} from '../bootstrap/png-assertions';

// Default Playwright viewport — every screenshot is captured at this
// size (the whole point of the CDP path is to NOT resize the device
// metrics, so the produced PNG matches the configured viewport).
const VIEWPORT_W = 1280;
const VIEWPORT_H = 720;

// CSS box of #in-viewport / #off-viewport buttons in
// `tests/integration/fixtures/screenshot-html/{short,tall}-page.html`.
// Both files use identical button geometry; only the page height
// and the second button's `top` differ.
const BUTTON_BOX = { x: 100, y: 100, width: 120, height: 40 };

// Optional: if `HEAL_VISUAL_DUMP_DIR` is set, every captured PNG is
// copied into that directory under a stable, slugified name so a
// human can open them in the Finder/file viewer to eyeball
// alignment. Independent of the assertions — copies happen before
// any assertion runs, so a failing case still leaves its PNG on
// disk for inspection. Use the `test:integration:visual:dump` npm
// script to run with the env var pre-set.
const DUMP_DIR = process.env.HEAL_VISUAL_DUMP_DIR;

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const SPEC = `import { test, expect } from '@playwright/test';

const base = process.env.INTEGRATION_BASE_URL as string;

test('action click on in-viewport target', async ({ page }) => {
  await page.goto(base + '/screenshot-html/short-page.html');
  await page.locator('#in-viewport').click();
});

test('action click on off-viewport target', async ({ page }) => {
  await page.goto(base + '/screenshot-html/tall-page.html');
  await page.locator('#off-viewport').click();
});

test('toBeVisible on in-viewport target', async ({ page }) => {
  await page.goto(base + '/screenshot-html/short-page.html');
  await expect(page.locator('#in-viewport')).toBeVisible();
});

test('toBeVisible on off-viewport target', async ({ page }) => {
  await page.goto(base + '/screenshot-html/tall-page.html');
  await expect(page.locator('#off-viewport')).toBeVisible();
});

test('toBeInViewport on in-viewport target', async ({ page }) => {
  await page.goto(base + '/screenshot-html/short-page.html');
  await expect(page.locator('#in-viewport')).toBeInViewport();
});

test('not.toBeInViewport on off-viewport target', async ({ page }) => {
  await page.goto(base + '/screenshot-html/tall-page.html');
  await expect(page.locator('#off-viewport')).not.toBeInViewport();
});
`;

interface CaptureMatch {
  testTitle: string;
  pngPath: string;
}

// The disk reader gives us a `Map<title, ParsedTrace>` but loses the
// (testId, attempt) pair we need to compose the screenshot path. We
// re-walk the heal-traces tree directly — one level deeper than the
// reader — to recover those identifiers per trace.
function indexCapturesByTitle(sandboxRoot: string): Map<string, CaptureMatch> {
  const reader = new DiskTraceReader();
  const tracesByTitle = reader.collect(sandboxRoot);

  const healTracesDir = path.join(sandboxRoot, 'heal-traces');
  const out = new Map<string, CaptureMatch>();
  // Layout: heal-traces/<execId>/<testId>/<attempt>/heal-traces.ndjson
  for (const execEntry of fs.readdirSync(healTracesDir, { withFileTypes: true })) {
    if (!execEntry.isDirectory()) continue;
    const execDir = path.join(healTracesDir, execEntry.name);
    for (const testEntry of fs.readdirSync(execDir, { withFileTypes: true })) {
      if (!testEntry.isDirectory()) continue;
      const testDir = path.join(execDir, testEntry.name);
      for (const attemptEntry of fs.readdirSync(testDir, { withFileTypes: true })) {
        if (!attemptEntry.isDirectory()) continue;
        const attemptDir = path.join(testDir, attemptEntry.name);
        const ndjson = path.join(attemptDir, 'heal-traces.ndjson');
        if (!fs.existsSync(ndjson)) continue;

        // Find the trace whose title matches by re-reading the
        // header from this specific ndjson — the reader's map is
        // keyed by title but doesn't expose the (testId, attempt).
        const lines = fs.readFileSync(ndjson, 'utf8').split('\n').filter(Boolean);
        let title: string | null = null;
        for (const line of lines) {
          const rec = JSON.parse(line) as { kind: string; test?: { title: string } };
          if (rec.kind === 'test-header' && rec.test) {
            title = rec.test.title;
            break;
          }
        }
        if (!title) continue;
        const trace = tracesByTitle.get(title);
        if (!trace) continue;

        const screenshotFiles: string[] = [];
        for (const { stmt } of walkStatements(trace.statements)) {
          if (stmt.screenshot) screenshotFiles.push(stmt.screenshot);
        }
        if (screenshotFiles.length !== 1) {
          throw new Error(
            `expected exactly one screenshot for "${title}", got ${screenshotFiles.length}: ${screenshotFiles.join(', ')}`,
          );
        }
        out.set(title, {
          testTitle: title,
          pngPath: path.join(attemptDir, 'screenshots', screenshotFiles[0]),
        });
      }
    }
  }
  return out;
}

describe('screenshot decoration — visual regression', () => {
  let captures: Map<string, CaptureMatch>;

  beforeAll(async () => {
    const tarballPath = process.env.INTEGRATION_TARBALL;
    if (!tarballPath) throw new Error('INTEGRATION_TARBALL not set — globalSetup failed?');

    const sandbox = new IntegrationSandbox({ tarballPath, specSource: SPEC });
    sandbox.scaffold();
    sandbox.install();
    await sandbox.runPlaywright();

    captures = indexCapturesByTitle(sandbox.getRoot());

    if (DUMP_DIR) {
      const absDump = path.resolve(DUMP_DIR);
      fs.mkdirSync(absDump, { recursive: true });
      for (const cap of captures.values()) {
        fs.copyFileSync(cap.pngPath, path.join(absDump, `${slugify(cap.testTitle)}.png`));
      }

      console.log(`[visual-dump] copied ${captures.size} PNGs to ${absDump}`);
    }
  }, 600_000);

  it('case 1 — action click, in-viewport target: magenta border at known box', () => {
    const cap = captures.get('action click on in-viewport target');
    expect(cap, 'capture for case 1').toBeDefined();
    const png = decodePng(cap!.pngPath);
    expectViewportSize(png, VIEWPORT_W, VIEWPORT_H);
    expectMagentaBorderAt(png, BUTTON_BOX);
  });

  it('case 2 — action click, off-viewport target: scrolled, border size matches CSS', () => {
    const cap = captures.get('action click on off-viewport target');
    expect(cap, 'capture for case 2').toBeDefined();
    const png = decodePng(cap!.pngPath);
    expectViewportSize(png, VIEWPORT_W, VIEWPORT_H);
    const found = findMagentaBoundingBox(png);
    expect(found, 'magenta overlay should be present after scroll').not.toBeNull();
    // Antialiased outermost row/column may add ±1px to the bbox.
    expect(found!.width).toBeGreaterThanOrEqual(BUTTON_BOX.width - 2);
    expect(found!.width).toBeLessThanOrEqual(BUTTON_BOX.width + 2);
    expect(found!.height).toBeGreaterThanOrEqual(BUTTON_BOX.height - 2);
    expect(found!.height).toBeLessThanOrEqual(BUTTON_BOX.height + 2);
  });

  it('case 3 — toBeVisible on in-viewport: magenta border at known box', () => {
    const cap = captures.get('toBeVisible on in-viewport target');
    expect(cap, 'capture for case 3').toBeDefined();
    const png = decodePng(cap!.pngPath);
    expectViewportSize(png, VIEWPORT_W, VIEWPORT_H);
    expectMagentaBorderAt(png, BUTTON_BOX);
  });

  it('case 4 — toBeVisible on off-viewport: scrolled, border size matches CSS', () => {
    const cap = captures.get('toBeVisible on off-viewport target');
    expect(cap, 'capture for case 4').toBeDefined();
    const png = decodePng(cap!.pngPath);
    expectViewportSize(png, VIEWPORT_W, VIEWPORT_H);
    const found = findMagentaBoundingBox(png);
    expect(found, 'magenta overlay should be present after scroll').not.toBeNull();
    expect(found!.width).toBeGreaterThanOrEqual(BUTTON_BOX.width - 2);
    expect(found!.width).toBeLessThanOrEqual(BUTTON_BOX.width + 2);
    expect(found!.height).toBeGreaterThanOrEqual(BUTTON_BOX.height - 2);
    expect(found!.height).toBeLessThanOrEqual(BUTTON_BOX.height + 2);
  });

  it('case 5 — toBeInViewport on in-viewport: not scrolled, border at known box', () => {
    const cap = captures.get('toBeInViewport on in-viewport target');
    expect(cap, 'capture for case 5').toBeDefined();
    const png = decodePng(cap!.pngPath);
    expectViewportSize(png, VIEWPORT_W, VIEWPORT_H);
    expectMagentaBorderAt(png, BUTTON_BOX);
  });

  it('case 6 — not.toBeInViewport on off-viewport: not scrolled, no magenta in PNG', () => {
    const cap = captures.get('not.toBeInViewport on off-viewport target');
    expect(cap, 'capture for case 6').toBeDefined();
    const png = decodePng(cap!.pngPath);
    expectViewportSize(png, VIEWPORT_W, VIEWPORT_H);
    expectNoMagentaInBox(png, { x: 0, y: 0, width: png.width, height: png.height });
  });
});
