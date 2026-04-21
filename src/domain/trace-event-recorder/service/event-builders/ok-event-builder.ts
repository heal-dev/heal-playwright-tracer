/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */

import type { TraceEventRecorderState } from '../trace-event-recorder-state';
import type { OkEvent } from '../../model/trace-schema';
import { safeVars } from '../serializers/variable-snapshot-serializer';

export function buildOkEvent(state: TraceEventRecorderState, vars?: unknown): void {
  const enter = state.enterStack.pop();
  if (!enter) return;
  const n = state.clock.now() - state.startedAt;
  const event: OkEvent = {
    type: 'ok',
    seq: ++state.seq,
    enterSeq: enter.seq,
    t: n,
    wallTime: Date.now(),
    duration: n - enter.t,
  };
  const serialized = safeVars(vars);
  if (serialized) event.vars = serialized;
  state.exporter.write(event);
}
