/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 *
 */

// Builds the `{ type: 'ok', ... }` event emitted when a traced
// statement finishes without throwing — the Babel-injected
// `__ok(vars?)` call fires from the `finally { if (!_threw) ... }`
// clause.
//
// Reads from state:
//   - enterStack.pop()         — the matching enter event
//   - clock.now() - startedAt  — for `t` and `duration`
//
// Writes to state:
//   - ++seq
//   - exporter.write(event)
//
// The `duration` field is the only perf measurement we emit —
// cpu/heap/event-loop-lag tracking was removed because the trace
// consumer only needs wall-clock execution time per statement.
//
// `vars` (when provided) carries the binding snapshot for
// `VariableDeclaration` statements — `const x = compute()` sends
// `{ x }` and we redact it through the variable-snapshot serializer
// before stamping it on the event.
//
// An orphan ok (pop with empty stack) is a silent no-op: the
// instrumenter guarantees matched pairs, but if somehow we receive
// an ok without a matching enter we choose to drop it rather than
// crash the test.

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
