// Factory for a TraceEventRecorderState suitable for unit-testing
// event builders directly. Each event builder is a pure-ish function
// of `(state, input) → void` that mutates state and writes to
// state.sink — this helper hands out a pre-wired state whose sink
// and clock are the deterministic test doubles.
//
// Prefer this over `buildHarness()` (from
// trace-event-recorder-harness.ts) when you want to test ONE builder
// in isolation. `buildHarness()` goes through the full
// TraceEventRecorder API and is the right choice for integration
// coverage in tests/trace-event-recorder/factory.test.ts.

import { createMemorySink } from '../../src/trace-event-recorder/adapters/memory-sink';
import { createActiveEnterStack } from '../../src/trace-event-recorder/active-enter-stack';
import type { TraceEventRecorderState } from '../../src/trace-event-recorder/state';
import type { Clock } from '../../src/trace-event-recorder/ports/clock';
import { createFakeClock } from './trace-event-recorder-harness';

interface TestStateOverrides {
  clock?: Clock & { advance?: (ms: number) => void; set?: (v: number) => void };
  staticContext?: Record<string, unknown>;
  dynamicContext?: Record<string, unknown> | null;
  currentPage?: unknown;
  seq?: number;
  startedAt?: number;
}

export function createTestRecorderState(
  overrides: TestStateOverrides = {},
): TraceEventRecorderState {
  const clock = overrides.clock ?? createFakeClock();
  return {
    sink: createMemorySink(),
    clock,
    staticContext: overrides.staticContext ?? {},
    dynamicContext: overrides.dynamicContext ?? null,
    currentPage: overrides.currentPage ?? null,
    enterStack: createActiveEnterStack(),
    stepStack: [],
    seq: overrides.seq ?? 0,
    startedAt: overrides.startedAt ?? 0,
  };
}

// Re-export the fake clock so tests that only need a clock can pull
// it from this helper instead of digging into the harness.
export { createFakeClock } from './trace-event-recorder-harness';
