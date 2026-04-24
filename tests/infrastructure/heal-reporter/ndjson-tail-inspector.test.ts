/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NdjsonTailInspector } from '../../../src/infrastructure/heal-reporter/ndjson-tail-inspector';

const inspector = new NdjsonTailInspector();

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-tail-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(filename: string, content: string): string {
  const p = path.join(tmpDir, filename);
  fs.writeFileSync(p, content);
  return p;
}

describe('NdjsonTailInspector', () => {
  it('returns true when the last line is a test-result record', () => {
    const p = write(
      'a.ndjson',
      '{"kind":"test-header","schemaVersion":1}\n' +
        '{"kind":"statement","statement":{"seq":1}}\n' +
        '{"kind":"test-result","status":"passed","duration":10}\n',
    );
    expect(inspector.endsWithTestResult(p)).toBe(true);
  });

  it('returns false when the last line is a statement record', () => {
    const p = write(
      'b.ndjson',
      '{"kind":"test-header","schemaVersion":1}\n' + '{"kind":"statement","statement":{"seq":1}}\n',
    );
    expect(inspector.endsWithTestResult(p)).toBe(false);
  });

  it('returns false for a missing file', () => {
    expect(inspector.endsWithTestResult(path.join(tmpDir, 'does-not-exist.ndjson'))).toBe(false);
  });

  it('returns false for an empty file', () => {
    const p = write('empty.ndjson', '');
    expect(inspector.endsWithTestResult(p)).toBe(false);
  });

  it('returns false when the file contains only a test-header', () => {
    const p = write('header-only.ndjson', '{"kind":"test-header","schemaVersion":1}\n');
    expect(inspector.endsWithTestResult(p)).toBe(false);
  });

  it('tolerates a torn (partial) last line from a crashed write', () => {
    const p = write(
      'torn.ndjson',
      '{"kind":"test-header","schemaVersion":1}\n' + '{"kind":"statement","statement":{"se',
    );
    expect(inspector.endsWithTestResult(p)).toBe(false);
  });

  it('reads only the tail for a file larger than 4 KB', () => {
    const filler =
      '{"kind":"statement","statement":{"seq":1,"source":"' + 'x'.repeat(8000) + '"}}\n';
    const p = write(
      'big.ndjson',
      filler + '{"kind":"test-result","status":"passed","duration":1}\n',
    );
    expect(inspector.endsWithTestResult(p)).toBe(true);
  });

  it('handles a file without a trailing newline', () => {
    const p = write(
      'no-newline.ndjson',
      '{"kind":"test-header","schemaVersion":1}\n' +
        '{"kind":"test-result","status":"failed","duration":5}',
    );
    expect(inspector.endsWithTestResult(p)).toBe(true);
  });
});
