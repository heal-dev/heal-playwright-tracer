/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ArtifactSummaryPrinter } from '../../../src/infrastructure/artifact-summary-printer';
import { HealDataLayout } from '../../../src/infrastructure/heal-data-layout';

class StreamSpy {
  readonly chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

const layout = new HealDataLayout('/tmp/out');

beforeEach(() => {
  delete process.env.HEAL_PRINT_ARTIFACT_PATHS;
});

afterEach(() => {
  delete process.env.HEAL_PRINT_ARTIFACT_PATHS;
});

describe('ArtifactSummaryPrinter#formatSummary', () => {
  it('produces a two-line summary with the test title, status, and outputDir', () => {
    const out = new ArtifactSummaryPrinter(layout).formatSummary({
      title: 'my test',
      status: 'passed',
    });
    expect(out).toBe(
      '[heal-playwright-tracer] my test (passed)\n' + '  test artifacts dir: /tmp/out\n',
    );
  });

  it('renders the status verbatim for non-passed results', () => {
    const out = new ArtifactSummaryPrinter(layout).formatSummary({
      title: 't',
      status: 'failed',
    });
    expect(out).toContain('(failed)');
  });
});

describe('ArtifactSummaryPrinter#print', () => {
  it('writes nothing when HEAL_PRINT_ARTIFACT_PATHS is unset', () => {
    const stream = new StreamSpy();
    new ArtifactSummaryPrinter(layout, stream).print({ title: 't', status: 'passed' });
    expect(stream.chunks).toHaveLength(0);
  });

  it.each(['0', 'true', 'yes', ''])('writes nothing when the env var is %j', (value) => {
    process.env.HEAL_PRINT_ARTIFACT_PATHS = value;
    const stream = new StreamSpy();
    new ArtifactSummaryPrinter(layout, stream).print({ title: 't', status: 'passed' });
    expect(stream.chunks).toHaveLength(0);
  });

  it('writes a single summary block when the env var is "1"', () => {
    process.env.HEAL_PRINT_ARTIFACT_PATHS = '1';
    const stream = new StreamSpy();
    new ArtifactSummaryPrinter(layout, stream).print({ title: 'my test', status: 'passed' });

    expect(stream.chunks).toHaveLength(1);
    expect(stream.chunks[0]).toBe(
      '[heal-playwright-tracer] my test (passed)\n' + '  test artifacts dir: /tmp/out\n',
    );
  });
});
