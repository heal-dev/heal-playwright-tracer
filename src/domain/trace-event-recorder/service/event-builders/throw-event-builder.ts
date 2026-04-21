/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Builds the `{ type: 'throw', ... }` event emitted when a traced
// statement throws — the Babel-injected `__throw(err)` call fires
// from the `catch (err) { ... }` clause, before the rethrow.
//
// Reads from state:
//   - enterStack.pop()         — the matching enter event (may be
//                                missing if __throw fires before
//                                any enter was emitted)
//   - clock.now() - startedAt  — for `t` and `duration`
//
// Writes to state:
//   - ++seq
//   - exporter.write(event)
//
// Orphan-throw tolerance: if `enterStack.pop()` returns undefined
// (an error escaping the very first instrumented statement of a
// run, for example), we still emit a throw event with
// `enterSeq: null` and `duration: 0` instead of crashing. The test
// harness can't paper over this because real test code can hit it.
//
// The thrown value goes through `serializeError` to produce the
// normalized `{ name, message, stack, causes, isPlaywrightError }`
// shape that downstream consumers rely on.

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
