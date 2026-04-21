/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */

import { TraceEventRecorder } from '../../src/domain/trace-event-recorder/service';
import type { TraceEventConsumer } from '../../src/domain/trace-event-recorder/port/trace-event-consumer';
import { createTraceEventConsumerStub } from './trace-event-consumer-stub';

export function createFakeClock(start = 1000, wallStart = 1_700_000_000_000) {
  let t = start;
  let wall = wallStart;
  return {
    now: () => t,
    wallNow: () => wall,
    advance: (ms: number) => {
      t += ms;
      wall += ms;
    },
    set: (value: number) => {
      t = value;
    },
    setWall: (value: number) => {
      wall = value;
    },
  };
}

// Tests destructure `{ rt, events }` — `events` is the live array
// the stub's `write()` pushes into. Reads never go through the
// consumer (which only exposes production methods: `write`, `clear`).
//
// Typed as `any[]` so assertions can poke at discriminated-union
// fields without repeated narrowing casts. The underlying stub types
// it as `TraceEvent[]`; the loosening happens at this boundary for
// test ergonomics.
export interface Harness {
  rt: TraceEventRecorder;
  consumer: TraceEventConsumer;
  events: any[];
  clock: ReturnType<typeof createFakeClock>;
}

export function buildHarness(staticContext: Record<string, unknown> = {}): Harness {
  const { consumer, events } = createTraceEventConsumerStub();
  const clock = createFakeClock();
  const rt = new TraceEventRecorder({ exporter: consumer, clock, staticContext });
  return { rt, consumer, events: events as unknown as any[], clock };
}
