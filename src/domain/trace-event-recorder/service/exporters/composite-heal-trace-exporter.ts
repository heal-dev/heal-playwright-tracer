/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// CompositeHealTraceExporter — GoF Composite over the HealTraceExporter
// port. Holds a list of child exporters and forwards every call to
// each of them, so clients treat one exporter and many exporters
// uniformly.
//
// Used by the fixture to feed BOTH the NDJSON file path and any
// user-registered exporter from a single `projector → exporter`
// pipeline. When only one child remains the fixture constructs that
// exporter directly and skips the composite.
//
// Error isolation: if one child throws from `write()` the others
// still receive the record. `close()` awaits every child's close
// promise — even if one rejects — so no leg is stranded.
//
// Lives in domain (not infrastructure) because it is pure
// composition over the port — no I/O, no external dependency. Any
// adapter can be wrapped in it without knowing it exists.

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
