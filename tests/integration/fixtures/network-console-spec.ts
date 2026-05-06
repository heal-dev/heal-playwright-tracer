/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Spec used by `tests/integration/specs/network-console.test.ts`.
//
// One test that exercises every sidecar code path from a real
// Playwright run:
//
//   - `console.log` from a runner-side statement → stdout (covered
//     by the stdout-capture path; included so the assertions can
//     verify the runner-side log does NOT appear in heal-console.ndjson)
//   - `console.warn` from `page.evaluate` → heal-console.ndjson
//     (level=warn, statementSeq populated)
//   - uncaught error inside `page.evaluate` → heal-console.ndjson
//     (level=pageerror, stack present)
//   - `fetch` from `page.evaluate` → heal-network.ndjson
//     (source=browser-context)
//   - `request.get(...)` from the apiRequestContext fixture →
//     heal-network.ndjson (source=api-request-context)
//
// `INTEGRATION_BASE_URL` is the static HTML page that global-setup
// serves; we hit it for the navigation and the fetch.

export const NETWORK_CONSOLE_SPEC = `import { test } from '@playwright/test';

const base = process.env.INTEGRATION_BASE_URL as string;

test('captures network and console sidecars', async ({ page, request }) => {
  // Page navigation — first network record (document fetch).
  await page.goto(base + '/');

  // Browser-page console message — should appear in heal-console.ndjson.
  await page.evaluate(() => console.warn('from-page-warn'));

  // Uncaught error in the page → 'pageerror' record. We swallow the
  // rejection so the test stays green.
  await page
    .evaluate(() => {
      setTimeout(() => {
        throw new Error('boom-from-page');
      }, 0);
      return new Promise((r) => setTimeout(r, 50));
    })
    .catch(() => {});

  // Browser-context fetch — second network record.
  await page.evaluate(async (u) => {
    await fetch(u);
  }, base + '/');

  // API-request-context — runner-side request, source='api-request-context'.
  await request.get(base + '/');
});
`;
