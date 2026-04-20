// Test harness: build a trace-event-recorder wired to a MemorySink
// plus a fake clock. Deterministic time keeps snapshot assertions
// stable across machines.

import { createTraceEventRecorder } from '../../src/trace-event-recorder/factory';
import { createMemorySink } from '../../src/trace-event-recorder/adapters/memory-sink';

export function createFakeClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (value: number) => {
      t = value;
    },
  };
}

// In tests the sink is treated as `any[]` so assertions can poke at
// fields without fighting the generic TraceEvent type. Production
// code keeps the tighter typing from trace-event-recorder/factory.ts.
interface TestSink {
  write(event: Record<string, unknown>): void;

  snapshot(): any[];
  clear(): void;
}

export function buildHarness(staticContext: Record<string, unknown> = {}) {
  const sink = createMemorySink();
  const clock = createFakeClock();
  const rt = createTraceEventRecorder({ sink, clock, staticContext });
  return { rt, sink: sink as unknown as TestSink, clock };
}
