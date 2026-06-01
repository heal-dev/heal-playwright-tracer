/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// End-to-end integration test for source-file capture.
//
// Scaffolds a sandbox that opts into
// `configureTracer({ source: { enabled: true } })`, runs a real
// Playwright spec that imports a local helper, then walks the on-disk
// trace tree and asserts the resolver-driven manifest landed both as
// a `test-source` record in `heal-traces.ndjson` and as copied files
// under `sources/`.

import * as fs from 'fs';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

import { IntegrationSandbox } from '../bootstrap/integration-sandbox';
import { SOURCE_CAPTURE_SPEC, SOURCE_CAPTURE_HELPER } from '../fixtures/source-capture-spec';
import type { HealTraceRecord } from '../../../src/domain/trace-event-recorder/model/statement-trace-schema';

interface SourceCaptureArtifacts {
  testDir: string;
  records: HealTraceRecord[];
}

let artifacts: SourceCaptureArtifacts;

function readNdjson<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

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
    specSource: SOURCE_CAPTURE_SPEC,
    extraFiles: { 'tests/helper.ts': SOURCE_CAPTURE_HELPER },
    withSourceCapture: true,
  });
  sandbox.scaffold();
  sandbox.install();
  await sandbox.runPlaywright();

  const testDir = findOnlyTestDir(sandbox.getRoot());
  artifacts = {
    testDir,
    records: readNdjson<HealTraceRecord>(path.join(testDir, 'heal-traces.ndjson')),
  };
});

describe('integration: source-file capture', () => {
  it('writes a sources/ directory under the per-test root', () => {
    expect(fs.existsSync(path.join(artifacts.testDir, 'sources'))).toBe(true);
  });

  it('copies the entry spec and the helper into sources/', () => {
    const specPath = path.join(artifacts.testDir, 'sources', 'tests', 'scenarios.spec.ts');
    const helperPath = path.join(artifacts.testDir, 'sources', 'tests', 'helper.ts');
    expect(fs.existsSync(specPath)).toBe(true);
    expect(fs.existsSync(helperPath)).toBe(true);
    expect(fs.readFileSync(specPath, 'utf8')).toContain("import { greet } from './helper'");
    expect(fs.readFileSync(helperPath, 'utf8')).toContain('export function greet');
  });

  it('emits a test-source record listing both files with entry on the spec', () => {
    const sourceRecord = artifacts.records.find((r) => r.kind === 'test-source');
    expect(sourceRecord).toBeDefined();
    if (!sourceRecord || sourceRecord.kind !== 'test-source') throw new Error('unreachable');

    const paths = sourceRecord.files.map((f) => f.path).sort();
    expect(paths).toEqual(['tests/helper.ts', 'tests/scenarios.spec.ts']);

    const spec = sourceRecord.files.find((f) => f.path === 'tests/scenarios.spec.ts');
    const helper = sourceRecord.files.find((f) => f.path === 'tests/helper.ts');
    expect(spec?.entry).toBe(true);
    expect(helper?.entry).toBeUndefined();
    expect(spec?.bytes).toBeGreaterThan(0);
    expect(helper?.bytes).toBeGreaterThan(0);
  });

  it('orders the test-source record before test-result', () => {
    const sourceIdx = artifacts.records.findIndex((r) => r.kind === 'test-source');
    const resultIdx = artifacts.records.findIndex((r) => r.kind === 'test-result');
    expect(sourceIdx).toBeGreaterThanOrEqual(0);
    expect(resultIdx).toBeGreaterThan(sourceIdx);
  });
});
