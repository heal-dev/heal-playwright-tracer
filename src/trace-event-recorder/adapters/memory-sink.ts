// MemorySink — in-memory adapter implementing the TraceSink port.
//
// Holds every written event in an array. `snapshot()` returns a shallow
// copy so callers cannot mutate the backing store. This is the default
// adapter used by the runtime and the one tests inject to assert on
// emitted events.

import type { TraceEvent, TraceSink } from '../ports/trace-sink';

export function createMemorySink(): TraceSink {
  const events: TraceEvent[] = [];
  return {
    write(event) {
      events.push(event);
    },
    snapshot() {
      return events.slice();
    },
    clear() {
      events.length = 0;
    },
  };
}
