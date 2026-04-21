/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NdjsonExporter } from '../../../src/infrastructure/ndjson-exporter-adapter';

let tmpFile: string;

beforeEach(() => {
  tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ndjson-exporter-')), 'trace.ndjson');
});

afterEach(() => {
  try {
    fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('NdjsonExporter', () => {
  it('writes one JSON record per line', async () => {
    const exporter = new NdjsonExporter(tmpFile);
    exporter.write({ kind: 'test-result', status: 'passed', duration: 1 });
    exporter.write({ kind: 'test-result', status: 'failed', duration: 2 });
    await exporter.close();

    const lines = fs.readFileSync(tmpFile, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ status: 'passed', duration: 1 });
    expect(JSON.parse(lines[1])).toMatchObject({ status: 'failed', duration: 2 });
  });

  it('appends to an existing file rather than truncating', async () => {
    fs.writeFileSync(tmpFile, '{"kind":"preexisting"}\n');
    const exporter = new NdjsonExporter(tmpFile);
    exporter.write({ kind: 'test-result', status: 'passed', duration: 0 });
    await exporter.close();

    const lines = fs.readFileSync(tmpFile, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('{"kind":"preexisting"}');
  });

  it('write is a no-op once the exporter is closed', async () => {
    const exporter = new NdjsonExporter(tmpFile);
    exporter.write({ kind: 'test-result', status: 'passed', duration: 0 });
    await exporter.close();
    expect(() =>
      exporter.write({ kind: 'test-result', status: 'failed', duration: 0 }),
    ).not.toThrow();

    const lines = fs.readFileSync(tmpFile, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
  });

  it('close is idempotent', async () => {
    const exporter = new NdjsonExporter(tmpFile);
    await exporter.close();
    await expect(exporter.close()).resolves.toBeUndefined();
  });
});
