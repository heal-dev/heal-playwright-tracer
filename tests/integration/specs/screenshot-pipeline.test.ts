/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Regression test for the screenshot decoration pipeline.
//
// Unit-test mocks can't enforce browser behaviour — Chromium
// rejecting a CDP method, Playwright's locator rejecting a slow
// boundingBox, the JS overlay being clobbered by a navigation. We
// spin up a real Chromium via Playwright, run a single patched
// `locator.click()` against the static integration HTML page, and
// assert the decoration pipeline runs cleanly.
//
// The signal: with `HEAL_DEBUG=1` the unified logger surfaces every
// best-effort recovery as a `[warn]` line on stderr (scroll
// throws, boundingBox null, overlay-cleanup catches, screenshot
// capture failures) and every real failure as `[error]`. If any
// decoration step is broken on a trivial page, a diagnostic
// message lands in stderr and this test fails. Without the env
// var, decoration is silent and a broken pipeline looks identical
// to a working one in the final trace.

import { describe, it, expect } from 'vitest';
import { IntegrationSandbox } from '../bootstrap/integration-sandbox';

const SCREENSHOT_SPEC = `import { test, expect } from '@playwright/test';

const base = process.env.INTEGRATION_BASE_URL as string;

test('screenshot decoration pipeline', async ({ page }) => {
  await page.goto(base + '/');
  const button = page.locator('#hello');
  await expect(button).toBeVisible();
  await button.click();
});
`;

describe('screenshot decoration pipeline — integration', () => {
  it('runs cleanly on Chromium with no warn or error log lines', async () => {
    const tarballPath = process.env.INTEGRATION_TARBALL;
    if (!tarballPath) throw new Error('INTEGRATION_TARBALL not set — globalSetup failed?');

    const sandbox = new IntegrationSandbox({
      tarballPath,
      specSource: SCREENSHOT_SPEC,
    });
    sandbox.scaffold();
    sandbox.install();

    const { code, stderr } = await sandbox.runPlaywrightCapturing({
      HEAL_DEBUG: '1',
    });

    expect(code).toBe(0);
    // No warn-level recovery — scroll, boundingBox, overlay draw,
    // overlay cleanup, screenshot capture all succeed first try.
    expect(stderr).not.toMatch(/\[heal-playwright-tracer\] \[warn\]/);
    // No error-level failures.
    expect(stderr).not.toMatch(/\[heal-playwright-tracer\] \[error\]/);
  }, 120_000);
});
