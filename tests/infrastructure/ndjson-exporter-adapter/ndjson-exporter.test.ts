/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
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

  it('writes the `prelude` records before any subsequent write()', async () => {
    const exporter = new NdjsonExporter(tmpFile, {
      prelude: [
        { kind: 'test-sidecars', network: 'heal-network.ndjson' },
        { kind: 'test-sidecars', console: 'heal-console.ndjson' },
      ],
    });
    exporter.write({ kind: 'test-result', status: 'passed', duration: 1 });
    await exporter.close();

    const lines = fs.readFileSync(tmpFile, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toMatchObject({
      kind: 'test-sidecars',
      network: 'heal-network.ndjson',
    });
    expect(JSON.parse(lines[1])).toMatchObject({
      kind: 'test-sidecars',
      console: 'heal-console.ndjson',
    });
    expect(JSON.parse(lines[2])).toMatchObject({ kind: 'test-result', status: 'passed' });
  });

  it('an empty `prelude` array is equivalent to omitting the option', async () => {
    const exporter = new NdjsonExporter(tmpFile, { prelude: [] });
    exporter.write({ kind: 'test-result', status: 'passed', duration: 0 });
    await exporter.close();
    const lines = fs.readFileSync(tmpFile, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
  });
});
