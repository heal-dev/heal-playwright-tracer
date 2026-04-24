/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// HTTP-route integration test.
//
// Same six scenarios as the disk variant, but the sandbox's
// `playwright.config.ts` plugs a stub-exporter via the public
// `configureTracer({ exporters: [...] })` API. The exporter POSTs each
// test's records as ndjson to a `StubCollectorServer` started in this
// process; assertions then run against the in-memory batches.
//
// Default `NdjsonExporter` stays wired alongside the stub-exporter,
// so this run also writes to disk — `scenarios-disk.test.ts` is the
// file that asserts on that path.

import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IntegrationSandbox } from '../bootstrap/integration-sandbox';
import { StubCollectorServer } from '../bootstrap/test-doubles/stub-collector-server';
import { HttpTraceReader } from '../bootstrap/test-doubles/http-trace-reader';
import { SCENARIO_SPEC } from '../fixtures/scenario-spec';
import { runScenarioAssertions } from './scenario-assertions';
import type { ParsedTrace } from '../fixtures/parsed-trace';
import type { RawBatch } from '../bootstrap/test-doubles/stub-collector-server';

let traces: Map<string, ParsedTrace>;
let batches: readonly RawBatch[];
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

  batches = stub.received();
  traces = new HttpTraceReader().collect(stub);
  if (traces.size === 0) {
    throw new Error('No traces received by stub-collector — did the user exporter wire up?');
  }
});

afterAll(async () => {
  await stub.stop();
});

runScenarioAssertions('http', () => traces);

describe('HealTracerTestContext.transport.healTracesFilePath', () => {
  it('is populated on the public context for every test', () => {
    expect(batches.length).toBeGreaterThan(0);
    for (const batch of batches) {
      expect(batch.healTracesFilePath, 'healTracesFilePath missing on context').toBeTruthy();
      expect(path.isAbsolute(batch.healTracesFilePath!)).toBe(true);
      expect(batch.healTracesFilePath!.endsWith(path.join('heal-data', 'heal-traces.ndjson'))).toBe(
        true,
      );
    }
  });

  it('points at a real ndjson file the NDJSON exporter wrote to', () => {
    for (const batch of batches) {
      const p = batch.healTracesFilePath!;
      const stat = fs.statSync(p);
      expect(stat.isFile()).toBe(true);
      expect(stat.size).toBeGreaterThan(0);
    }
  });
});
