/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */

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
