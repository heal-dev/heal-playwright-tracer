/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Negative path: the Babel plugin is wired but the reporter is not.
// The fixture must throw with a clear diagnostic on the first test in
// each worker so users can't silently produce half-broken traces.

import { describe, it, expect } from 'vitest';
import { IntegrationSandbox } from '../bootstrap/integration-sandbox';

const TRIVIAL_SPEC = `import { test, expect } from '@playwright/test';

test('does not run', async () => {
  expect(1).toBe(1);
});
`;

describe('reporter required', () => {
  it('fails fast with a diagnostic when the reporter is not registered', async () => {
    const tarballPath = process.env.INTEGRATION_TARBALL;
    if (!tarballPath) throw new Error('INTEGRATION_TARBALL not set — globalSetup failed?');

    const sandbox = new IntegrationSandbox({
      tarballPath,
      specSource: TRIVIAL_SPEC,
      withoutHealReporter: true,
    });
    sandbox.scaffold();
    sandbox.install();

    const { code, stdout, stderr } = await sandbox.runPlaywrightCapturing();
    const combined = stdout + stderr;

    expect(code).not.toBe(0);
    expect(combined).toContain('@heal-dev/heal-playwright-tracer');
    expect(combined).toContain('reporter is not registered');
    expect(combined).toContain("reporter: [['@heal-dev/heal-playwright-tracer/reporter']]");
  }, 120_000);
});
