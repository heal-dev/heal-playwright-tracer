// TraceSink — port (interface) for where trace events go.
//
// A sink is a plain object implementing:
//
//   write(event)         → void
//     Called for every trace event the runtime produces (meta, enter,
//     ok, throw). Events are plain JSON-serializable
//     objects; the sink MUST NOT mutate them.
//
//   snapshot()           → TraceEvent[]
//     Returns a copy of the events recorded so far. Used by the
//     fixture teardown to flush to disk and by tests to assert on
//     what was emitted. Copy semantics mean mutating the returned
//     array does not affect future writes.
//
//   clear()              → void
//     Drops every event previously written. Called from reset() at
//     the start of each test so the buffer only contains events from
//     the current test.
//
// Adapters in ../adapters/ implement this contract. The default runtime
// uses MemorySink; tests inject their own to assert on emitted events.

import type { TraceEvent } from '../trace-schema';

export type { TraceEvent };

export interface TraceSink {
  write(event: TraceEvent): void;
  snapshot(): TraceEvent[];
  clear(): void;
}
