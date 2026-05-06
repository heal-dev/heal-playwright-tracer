/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// End-to-end integration test for the per-statement pre-processor
// extension surface. Builds + packs + installs the tracer into a
// sandbox configured with `configureTracer({ preProcessors: [...] })`,
// runs a real Playwright spec whose source contains recognizable
// `marker:<word>` patterns, then walks the on-disk
// `<testDir>/preprocess-record.ndjson` and asserts the preprocessor
// (a) ran for every traced async leaf, (b) saw the meta object the
// recorder also gets, and (c) had access to the live `BrowserContext`
// through `StatementPreProcessorContext`.
//
// This is the only integration test that exercises the full
// configureTracer → fixture-install → globalThis.__heal_preprocess →
// emitted-await chain through a real Playwright runtime.

import { beforeAll, describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { IntegrationSandbox } from '../bootstrap/integration-sandbox';
import { PREPROCESS_SPEC } from '../fixtures/preprocess-spec';

interface PreprocessRecord {
  marker: string;
  file: string;
  startLine: number;
  kind: string;
  source: string;
}

let testDir: string;
let preprocessRecords: PreprocessRecord[];

function findOnlyTestDir(sandboxRoot: string): string {
  const healTracesRoot = path.join(sandboxRoot, 'heal-traces');
  for (const exec of fs.readdirSync(healTracesRoot, { withFileTypes: true })) {
    if (!exec.isDirectory()) continue;
    const execDir = path.join(healTracesRoot, exec.name);
    for (const test of fs.readdirSync(execDir, { withFileTypes: true })) {
      if (!test.isDirectory()) continue;
      const testRoot = path.join(execDir, test.name);
      for (const attempt of fs.readdirSync(testRoot, { withFileTypes: true })) {
        if (!attempt.isDirectory()) continue;
        return path.join(testRoot, attempt.name);
      }
    }
  }
  throw new Error(`No test attempt directory found under ${healTracesRoot}`);
}

beforeAll(async () => {
  const tarballPath = process.env.INTEGRATION_TARBALL;
  if (!tarballPath) throw new Error('INTEGRATION_TARBALL not set — globalSetup failed?');

  const sandbox = new IntegrationSandbox({
    tarballPath,
    specSource: PREPROCESS_SPEC,
    withPreProcessor: true,
  });
  sandbox.scaffold();
  sandbox.install();
  await sandbox.runPlaywright();

  testDir = findOnlyTestDir(sandbox.getRoot());
  const recordPath = path.join(testDir, 'preprocess-record.ndjson');
  preprocessRecords = fs.existsSync(recordPath)
    ? fs
        .readFileSync(recordPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as PreprocessRecord)
    : [];
});

describe('integration: statement pre-processor', () => {
  it('writes one preprocess-record entry per `marker:<word>` source hit', () => {
    // The spec has two leaves carrying markers:
    //   1. `await page.goto(base + '/'); // marker:goto`
    //   2. `const button = page.locator('#hello'); // marker:locator`
    // The third leaf (`await expect(button).toBeVisible();`) has no marker.
    expect(preprocessRecords).toHaveLength(2);
    const markers = preprocessRecords.map((r) => r.marker).sort();
    expect(markers).toEqual(['goto', 'locator']);
  });

  it('passes the same meta payload the trace recorder gets (file, kind, source, startLine)', () => {
    const goto = preprocessRecords.find((r) => r.marker === 'goto');
    expect(goto).toBeDefined();
    expect(goto!.file).toMatch(/scenarios\.spec\.ts$/);
    expect(goto!.kind).toBe('expression');
    expect(goto!.source).toContain(`page.goto`);
    expect(goto!.source).toContain(`marker:goto`);
    expect(typeof goto!.startLine).toBe('number');
    expect(goto!.startLine).toBeGreaterThan(0);

    const locator = preprocessRecords.find((r) => r.marker === 'locator');
    expect(locator).toBeDefined();
    // The hoisted `const` declaration retains kind=`variable` so consumers
    // can dispatch differently for declarations vs. expressions.
    expect(locator!.kind).toBe('variable');
    expect(locator!.source).toContain(`page.locator`);
  });

  it('exposes the live BrowserContext through StatementPreProcessorContext', () => {
    // The preprocessor throws if `ctx.browserContext` is missing; the
    // throw would land as a `__heal_throw` on the statement and
    // surface in the trace. We verify it didn't by checking the test
    // result status from the main NDJSON.
    const mainNdjsonPath = path.join(testDir, 'heal-traces.ndjson');
    const records = fs
      .readFileSync(mainNdjsonPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; status?: string });
    const result = records.find((r) => r.kind === 'test-result');
    expect(result).toBeDefined();
    expect(result!.status).toBe('passed');
  });
});
