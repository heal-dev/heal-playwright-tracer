/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 */
// Stub for the `TraceEventConsumer` port used in unit tests.
//
// Returns two things:
//   - `consumer` — implements exactly `TraceEventConsumer` (write + clear),
//     nothing more. This is what tests pass to
//     `new TraceEventRecorder({ exporter })` or `createTestRecorderState()`.
//   - `events`   — the live array the consumer writes into. Tests read this
//     directly to assert on what the recorder emitted.
//
// The split keeps tests honest: the consumer they inject has the exact
// same public surface production code has (`write`, `clear`); no
// test-only methods leak onto it. Inspection happens via the captured
// reference, not through the port.

import type {
  TraceEvent,
  TraceEventConsumer,
} from '../../src/domain/trace-event-recorder/port/trace-event-consumer';

export interface TraceEventConsumerStub {
  consumer: TraceEventConsumer;
  events: TraceEvent[];
}

export function createTraceEventConsumerStub(): TraceEventConsumerStub {
  const events: TraceEvent[] = [];
  const consumer: TraceEventConsumer = {
    write(event) {
      events.push(event);
    },
    clear() {
      events.length = 0;
    },
  };
  return { consumer, events };
}
