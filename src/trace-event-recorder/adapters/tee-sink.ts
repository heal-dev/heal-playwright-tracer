// TeeSink — HealTraceSink adapter that forwards every record to a
// list of inner sinks.
//
// Used by the fixture to feed BOTH the NDJSON file path and the
// local agent HTTP path from a single `projector → sink` pipeline.
// Either leg can be disabled via env flags on the fixture side;
// when only one leg remains the fixture constructs that sink
// directly and skips the tee.
//
// Error isolation: if one inner sink throws from `write()` the
// others still receive the record. `close()` awaits every inner
// sink's close promise — even if one rejects — so no leg is
// stranded.

import type { HealTraceSink, HealTraceRecord } from '../ports/heal-trace-sink';

export function createTeeSink(inners: HealTraceSink[]): HealTraceSink {
  return {
    write(record: HealTraceRecord) {
      for (const sink of inners) {
        try {
          sink.write(record);
        } catch (err) {
          console.warn('[heal-playwright-tracer] tee-sink inner write failed:', err);
        }
      }
    },
    async close() {
      const results = await Promise.allSettled(inners.map((s) => s.close()));
      for (const r of results) {
        if (r.status === 'rejected') {
          console.warn('[heal-playwright-tracer] tee-sink inner close failed:', r.reason);
        }
      }
    },
  };
}
