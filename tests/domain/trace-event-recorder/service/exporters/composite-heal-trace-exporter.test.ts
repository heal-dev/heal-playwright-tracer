/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 *
 */

import { describe, it, expect, vi } from 'vitest';
import { CompositeHealTraceExporter } from '../../../../../src/domain/trace-event-recorder/service/exporters/composite-heal-trace-exporter';
import type {
  HealTraceExporter,
  HealTraceRecord,
} from '../../../../../src/domain/trace-event-recorder/port/heal-trace-exporter';

function recordingChild(): HealTraceExporter & { records: HealTraceRecord[]; closed: boolean } {
  const records: HealTraceRecord[] = [];
  return {
    records,
    closed: false,
    write(r) {
      this.records.push(r);
    },
    async close() {
      this.closed = true;
    },
  } as HealTraceExporter & { records: HealTraceRecord[]; closed: boolean };
}

const sampleRecord: HealTraceRecord = {
  kind: 'test-result',
  status: 'passed',
  duration: 1,
};

describe('CompositeHealTraceExporter', () => {
  it('write forwards the same record to every child', () => {
    const a = recordingChild();
    const b = recordingChild();
    const composite = new CompositeHealTraceExporter([a, b]);

    composite.write(sampleRecord);

    expect(a.records).toEqual([sampleRecord]);
    expect(b.records).toEqual([sampleRecord]);
  });

  it('write isolates a throwing child: remaining children still receive the record', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad: HealTraceExporter = {
      write() {
        throw new Error('bad');
      },
      close: async () => {},
    };
    const good = recordingChild();
    const composite = new CompositeHealTraceExporter([bad, good]);

    composite.write(sampleRecord);

    expect(good.records).toEqual([sampleRecord]);
    expect(warnSpy).toHaveBeenCalledWith(
      '[heal-playwright-tracer] composite-exporter child write failed:',
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it('close awaits every child even when one rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = recordingChild();
    const rejecting: HealTraceExporter = {
      write: () => {},
      close: async () => {
        throw new Error('close-fail');
      },
    };
    const c = recordingChild();
    const composite = new CompositeHealTraceExporter([a, rejecting, c]);

    await composite.close();

    expect(a.closed).toBe(true);
    expect(c.closed).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      '[heal-playwright-tracer] composite-exporter child close failed:',
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it('close with zero children resolves', async () => {
    const composite = new CompositeHealTraceExporter([]);
    await expect(composite.close()).resolves.toBeUndefined();
  });
});
