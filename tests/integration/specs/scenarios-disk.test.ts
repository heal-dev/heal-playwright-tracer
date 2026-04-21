/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Disk-route integration test.
//
// Runs the six scenarios in a fresh sandbox, then collects traces by
// walking `${sandbox}/test-results/**/heal-traces.ndjson` — proving
// the always-on `NdjsonExporter` works end-to-end.

import { beforeAll } from 'vitest';
import { IntegrationSandbox } from '../bootstrap/integration-sandbox';
import { DiskTraceReader } from '../bootstrap/test-doubles/disk-trace-reader';
import { SCENARIO_SPEC } from '../fixtures/scenario-spec';
import { runScenarioAssertions } from './scenario-assertions';
import type { ParsedTrace } from '../fixtures/parsed-trace';

let traces: Map<string, ParsedTrace>;

beforeAll(async () => {
  const tarballPath = process.env.INTEGRATION_TARBALL;
  if (!tarballPath) throw new Error('INTEGRATION_TARBALL not set — globalSetup failed?');

  const sandbox = new IntegrationSandbox({ tarballPath, specSource: SCENARIO_SPEC });
  sandbox.scaffold();
  sandbox.install();
  await sandbox.runPlaywright();

  traces = new DiskTraceReader().collect(sandbox.getRoot());
  if (traces.size === 0) {
    throw new Error('No traces collected from disk — did the sandbox spec run at all?');
  }
});

runScenarioAssertions('disk', () => traces);
