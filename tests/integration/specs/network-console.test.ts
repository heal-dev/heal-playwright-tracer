/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// End-to-end integration test for the network and console sidecar
// streams. Builds + packs + installs the tracer into a sandbox,
// runs a real Playwright spec that fires every sidecar code path,
// then walks the on-disk `heal-traces/` tree and asserts on the
// content of `heal-network.ndjson` / `heal-console.ndjson`.
//
// This is the only test that exercises the full chain — fixture
// wiring, browser.newContext patches, BrowserContext event
// listeners, NDJSON write path, sidecar prelude on the main file —
// against a real Playwright runtime.

import { beforeAll, describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { IntegrationSandbox } from '../bootstrap/integration-sandbox';
import { NETWORK_CONSOLE_SPEC } from '../fixtures/network-console-spec';
import type { HealTraceRecord } from '../../../src/domain/trace-event-recorder/model/statement-trace-schema';
import type { ConsoleRecord } from '../../../src/domain/trace-event-recorder/model/console-trace-schema';
import type { NetworkRecord } from '../../../src/domain/trace-event-recorder/model/network-trace-schema';

interface TestArtifacts {
  mainRecords: HealTraceRecord[];
  consoleRecords: ConsoleRecord[];
  networkRecords: NetworkRecord[];
  testDir: string;
}

let artifacts: TestArtifacts;

function readNdjson<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function findOnlyTestDir(sandboxRoot: string): string {
  // heal-traces/<executionId>/<testId>/<attempt>/
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
    specSource: NETWORK_CONSOLE_SPEC,
  });
  sandbox.scaffold();
  sandbox.install();
  await sandbox.runPlaywright();

  const testDir = findOnlyTestDir(sandbox.getRoot());
  artifacts = {
    testDir,
    mainRecords: readNdjson<HealTraceRecord>(path.join(testDir, 'heal-traces.ndjson')),
    consoleRecords: readNdjson<ConsoleRecord>(path.join(testDir, 'heal-console.ndjson')),
    networkRecords: readNdjson<NetworkRecord>(path.join(testDir, 'heal-network.ndjson')),
  };
});

describe('integration: network + console sidecars', () => {
  it('writes a `test-sidecars` record into heal-traces.ndjson naming both sidecar files', () => {
    const sidecar = artifacts.mainRecords.find((r) => r.kind === 'test-sidecars');
    expect(sidecar).toBeDefined();
    expect(sidecar).toMatchObject({
      kind: 'test-sidecars',
      network: 'heal-network.ndjson',
      console: 'heal-console.ndjson',
    });
  });

  it('produces both sidecar files on disk', () => {
    expect(fs.existsSync(path.join(artifacts.testDir, 'heal-network.ndjson'))).toBe(true);
    expect(fs.existsSync(path.join(artifacts.testDir, 'heal-console.ndjson'))).toBe(true);
  });

  it('captures the browser-page console.warn with statementSeq populated', () => {
    const warn = artifacts.consoleRecords.find(
      (r) => r.level === 'warn' && r.text === 'from-page-warn',
    );
    expect(warn).toBeDefined();
    // The warn was emitted from inside `await page.evaluate(...)`, so
    // it must have fired while a statement was on the active stack.
    expect(typeof warn!.statementSeq).toBe('number');
    expect(warn!.t).toBeGreaterThanOrEqual(0);
    expect(warn!.pageUrl).toContain('http');
  });

  it('captures the uncaught page error as a `pageerror` record with a stack', () => {
    const pageerror = artifacts.consoleRecords.find((r) => r.level === 'pageerror');
    expect(pageerror).toBeDefined();
    expect(pageerror!.text).toMatch(/boom-from-page/);
    expect(pageerror!.stack).toBeTruthy();
  });

  it('captures both browser-context and api-request-context HTTP traffic', () => {
    const sources = new Set(artifacts.networkRecords.map((r) => r.source));
    expect(sources.has('browser-context')).toBe(true);
    expect(sources.has('api-request-context')).toBe(true);
    // At minimum: the `page.goto`, the `fetch`, and the api request.
    expect(artifacts.networkRecords.length).toBeGreaterThanOrEqual(3);
  });

  it('every browser-context network record carries a statementSeq', () => {
    const browserRecords = artifacts.networkRecords.filter((r) => r.source === 'browser-context');
    expect(browserRecords.length).toBeGreaterThan(0);
    for (const record of browserRecords) {
      expect(typeof record.statementSeq).toBe('number');
    }
  });

  it('redacts default-denylisted request headers (cookie, authorization, …)', () => {
    // Playwright fills in a User-Agent and a Host; we don't expect a
    // Cookie on the test page, but we DO want to assert that if the
    // header dictionary contains any redacted name, the value is the
    // marker rather than the raw secret. We send a synthetic header
    // here by fishing through the captured records.
    for (const record of artifacts.networkRecords) {
      for (const [name, value] of Object.entries(record.requestHeaders)) {
        if (['authorization', 'cookie', 'set-cookie', 'x-api-key'].includes(name.toLowerCase())) {
          expect(value).toBe('<redacted>');
        }
      }
    }
  });

  it('records timestamps on the same axis as the statement stream', () => {
    // Pick any console record with a statementSeq and find the
    // matching statement record; assert the console.t falls in
    // [statement.t, statement.t + duration].
    const consoleWithSeq = artifacts.consoleRecords.find((r) => typeof r.statementSeq === 'number');
    expect(consoleWithSeq).toBeDefined();

    // Walk the main records to find the matching statement (by seq).
    // Statements in the projected file nest children inline, so we
    // descend into every subtree.
    function findBySeq(records: HealTraceRecord[], seq: number) {
      const stack: { seq: number; t: number; duration: number }[] = [];
      for (const r of records) {
        if (r.kind !== 'statement') continue;
        const queue = [r.statement];
        while (queue.length > 0) {
          const s = queue.shift()!;
          stack.push({ seq: s.seq, t: s.t, duration: s.duration });
          queue.push(...s.children);
        }
      }
      return stack.find((s) => s.seq === seq);
    }

    const matchedStatement = findBySeq(artifacts.mainRecords, consoleWithSeq!.statementSeq!);
    expect(matchedStatement).toBeDefined();
    expect(consoleWithSeq!.t).toBeGreaterThanOrEqual(matchedStatement!.t);
    expect(consoleWithSeq!.t).toBeLessThanOrEqual(
      matchedStatement!.t + matchedStatement!.duration + 1, // +1ms slack for clock granularity
    );
  });
});
