/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Spec for the pre-processor integration test. Two statements:
// one with a recognizable marker in its source, one without. The
// preprocessor scans for the marker and records a hit per match,
// proving the fixture wires `globalThis.__heal_preprocess` to the
// registered function and that the meta payload arrives intact.

// The markers must live INSIDE the statement text (between
// `node.start` and `node.end`) because the preprocessor receives
// `meta.source` from the snippet extractor, not the trailing inline
// comments — Babel attaches those to the NEXT statement.
//
// Embedding `marker:<word>` in a URL query and a CSS selector keeps
// the spec runnable against the integration HTTP server while
// providing recognizable markers for the preprocessor's regex.
export const PREPROCESS_SPEC = `import { test, expect } from '@playwright/test';

const base = process.env.INTEGRATION_BASE_URL as string;

test('preprocess matches markers in source', async ({ page }) => {
  await page.goto(base + '/?marker:goto');
  const button = page.locator('#hello,[data-test="marker:locator"]');
  await expect(button).toBeVisible();
});
`;
