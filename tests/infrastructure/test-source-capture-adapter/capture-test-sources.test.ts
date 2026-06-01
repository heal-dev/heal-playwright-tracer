/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  captureTestSources,
  _clearGraphCacheForTests,
} from '../../../src/infrastructure/test-source-capture-adapter/capture-test-sources';
import type { HealTraceRecord } from '../../../src/domain/trace-event-recorder/port/heal-trace-exporter';

/** Tiny in-memory exporter that records every write. */
class RecordingExporter {
  readonly records: HealTraceRecord[] = [];
  write(record: HealTraceRecord): void {
    this.records.push(record);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

const buildTree = (files: Record<string, string>): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'heal-capture-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return root;
};

describe('captureTestSources', () => {
  beforeEach(() => {
    _clearGraphCacheForTests();
  });

  it('copies the entry file plus imports and emits a test-source record', () => {
    const root = buildTree({
      'tests/a.spec.ts': "import { x } from '../pages/login';\nconst _ = x;\n",
      'pages/login.ts': 'export const x = 1;\n',
    });
    const sourcesDir = path.join(root, 'heal-traces', 'sources');
    const exporter = new RecordingExporter();

    captureTestSources({
      entryFile: path.join(root, 'tests/a.spec.ts'),
      rootDir: root,
      sourcesDir,
      exporter,
    });

    expect(exporter.records).toHaveLength(1);
    const rec = exporter.records[0];
    expect(rec.kind).toBe('test-source');
    if (rec.kind !== 'test-source') throw new Error('unreachable');

    const paths = rec.files.map((f) => f.path).sort();
    expect(paths).toEqual(['pages/login.ts', 'tests/a.spec.ts']);

    const entry = rec.files.find((f) => f.path === 'tests/a.spec.ts');
    expect(entry?.entry).toBe(true);
    expect(entry?.bytes).toBe(statSync(path.join(root, 'tests/a.spec.ts')).size);

    // Files were copied to disk.
    expect(readFileSync(path.join(sourcesDir, 'tests/a.spec.ts'), 'utf8')).toContain('login');
    expect(readFileSync(path.join(sourcesDir, 'pages/login.ts'), 'utf8')).toContain('export');
  });

  it('writes nothing when the graph is empty (entry outside root)', () => {
    const root = buildTree({ 'tests/a.spec.ts': '' });
    const exporter = new RecordingExporter();
    captureTestSources({
      entryFile: '/elsewhere/x.ts',
      rootDir: root,
      sourcesDir: path.join(root, 'heal-traces', 'sources'),
      exporter,
    });
    expect(exporter.records).toEqual([]);
  });

  it('marks oversized files truncated and skips the copy', () => {
    const root = buildTree({
      'tests/a.spec.ts': 'x'.repeat(2000),
    });
    const sourcesDir = path.join(root, 'heal-traces', 'sources');
    const exporter = new RecordingExporter();

    captureTestSources({
      entryFile: path.join(root, 'tests/a.spec.ts'),
      rootDir: root,
      sourcesDir,
      exporter,
      config: { maxFileBytes: 100 },
    });

    expect(exporter.records).toHaveLength(1);
    const rec = exporter.records[0];
    if (rec.kind !== 'test-source') throw new Error('unreachable');
    expect(rec.files[0]).toMatchObject({
      path: 'tests/a.spec.ts',
      truncated: true,
      entry: true,
    });
    expect(rec.files[0].bytes).toBe(2000);
    // No file copied for the truncated entry.
    expect(existsSync(path.join(sourcesDir, 'tests/a.spec.ts'))).toBe(false);
  });

  it('survives a write failure without throwing (logs and continues)', () => {
    const root = buildTree({ 'tests/a.spec.ts': '' });
    const exporter = new RecordingExporter();
    const failingExporter = {
      write(): void {
        throw new Error('boom');
      },
      close(): Promise<void> {
        return Promise.resolve();
      },
    };
    const logs: string[] = [];
    expect(() =>
      captureTestSources({
        entryFile: path.join(root, 'tests/a.spec.ts'),
        rootDir: root,
        sourcesDir: path.join(root, 'heal-traces', 'sources'),
        exporter: failingExporter,
        log: (msg) => logs.push(msg),
      }),
    ).not.toThrow();
    expect(logs.some((m) => m.includes('exporter write failed'))).toBe(true);
    expect(exporter.records).toEqual([]);
  });
});
