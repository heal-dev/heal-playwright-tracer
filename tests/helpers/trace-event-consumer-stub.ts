/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */

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
