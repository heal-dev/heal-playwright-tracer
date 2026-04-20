// Builds the `{ type: 'meta', ... }` event that marks the start of
// a new recording session. Called from `reset()` — which is itself
// called once per test, right after the fixture captures per-test
// context and before the test body runs.
//
// The meta event is the only event that merges both the per-process
// static context (schemaVersion, pid, nodeVersion, platform, arch,
// hostname, isCI, cwd, gitSha — gathered once at process start) AND
// the per-test dynamic context (workerIndex, testId, testTitle,
// projectName, testFile, retry — set via setContext() before each
// test).
//
// Downstream consumers (the autopilot agent, the report viewer)
// read the meta event to know which test produced the rest of the
// trace, on which machine, at which git SHA.
//
// This file only BUILDS the event. Clearing the sink and resetting
// the stack/seq/startedAt state is done by core.ts around the call,
// so that side effects stay visible at the factory level.

import type { TraceEventRecorderState } from '../state';
import type { MetaEvent } from '../trace-schema';

export function buildMetaEvent(state: TraceEventRecorderState): void {
  const event: MetaEvent = {
    ...state.staticContext,
    ...(state.dynamicContext ?? {}),
    type: 'meta',
    seq: ++state.seq,
    t: 0,
    wallTime: Date.now(),
  };
  state.sink.write(event);
}
