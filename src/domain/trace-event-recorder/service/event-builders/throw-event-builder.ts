/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */

import type { TraceEventRecorderState } from '../trace-event-recorder-state';
import type { ThrowEvent } from '../../model/trace-schema';
import { serializeError } from '../serializers/error-serializer';

export function buildThrowEvent(state: TraceEventRecorderState, err: unknown): void {
  const enter = state.enterStack.pop();
  const n = state.clock.now() - state.startedAt;
  const event: ThrowEvent = {
    type: 'throw',
    seq: ++state.seq,
    enterSeq: enter ? enter.seq : null,
    t: n,
    wallTime: Date.now(),
    duration: enter ? n - enter.t : 0,
    error: serializeError(err),
  };
  state.exporter.write(event);
}
