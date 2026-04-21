/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import type { HealTraceExporter, HealTraceRecord } from '../../port/heal-trace-exporter';

export class CompositeHealTraceExporter implements HealTraceExporter {
  constructor(private readonly children: HealTraceExporter[]) {}

  write(record: HealTraceRecord): void {
    for (const child of this.children) {
      try {
        child.write(record);
      } catch (err) {
        console.warn('[heal-playwright-tracer] composite-exporter child write failed:', err);
      }
    }
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled(this.children.map((c) => c.close()));
    for (const r of results) {
      if (r.status === 'rejected') {
        console.warn('[heal-playwright-tracer] composite-exporter child close failed:', r.reason);
      }
    }
  }
}
