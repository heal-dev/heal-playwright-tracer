/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */

import { beforeAll, afterAll } from 'vitest';
import { IntegrationSandbox } from '../bootstrap/integration-sandbox';
import { StubCollectorServer } from '../bootstrap/test-doubles/stub-collector-server';
import { HttpTraceReader } from '../bootstrap/test-doubles/http-trace-reader';
import { SCENARIO_SPEC } from '../fixtures/scenario-spec';
import { runScenarioAssertions } from './scenario-assertions';
import type { ParsedTrace } from '../fixtures/parsed-trace';

let traces: Map<string, ParsedTrace>;
const stub = new StubCollectorServer();

beforeAll(async () => {
  const tarballPath = process.env.INTEGRATION_TARBALL;
  if (!tarballPath) throw new Error('INTEGRATION_TARBALL not set — globalSetup failed?');

  const { url } = await stub.start();

  const sandbox = new IntegrationSandbox({
    tarballPath,
    specSource: SCENARIO_SPEC,
    withStubExporter: true,
  });
  sandbox.scaffold();
  sandbox.install();
  await sandbox.runPlaywright({ STUB_COLLECTOR_URL: url });

  traces = new HttpTraceReader().collect(stub);
  if (traces.size === 0) {
    throw new Error('No traces received by stub-collector — did the user exporter wire up?');
  }
});

afterAll(async () => {
  await stub.stop();
});

runScenarioAssertions('http', () => traces);
