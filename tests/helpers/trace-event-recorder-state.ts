/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 */
// Factory for a TraceEventRecorderState suitable for unit-testing
// event builders directly. Each event builder is a pure-ish function
// of `(state, input) → void` that mutates state and writes to
// `state.exporter` — this helper hands out a pre-wired state plus the
// live `events` array the stub consumer pushes into, so tests can
// read what was written without calling any non-production method on
// the consumer itself.
//
// Prefer this over `buildHarness()` (from
// trace-event-recorder-harness.ts) when you want to test ONE builder
// in isolation. `buildHarness()` goes through the full
// TraceEventRecorder API and is the right choice for integration
// coverage in tests/trace-event-recorder/factory.test.ts.

import { createTraceEventConsumerStub } from './trace-event-consumer-stub';
import {
  ActiveEnterStack,
  type TraceEventRecorderState,
} from '../../src/domain/trace-event-recorder/service';
import type { Clock } from '../../src/domain/trace-event-recorder/port/clock';
import { createFakeClock } from './trace-event-recorder-harness';

interface TestStateOverrides {
  clock?: Clock & { advance?: (ms: number) => void; set?: (v: number) => void };
  staticContext?: Record<string, unknown>;
  dynamicContext?: Record<string, unknown> | null;
  currentPage?: unknown;
  seq?: number;
  startedAt?: number;
}

export interface TestRecorderState extends TraceEventRecorderState {
  /**
   * Live buffer the consumer stub pushes into. Read for assertions.
   * Typed as `any[]` so tests can poke at discriminated-union fields
   * without repeated narrowing casts.
   */
  events: any[];
}

export function createTestRecorderState(overrides: TestStateOverrides = {}): TestRecorderState {
  const { consumer, events } = createTraceEventConsumerStub();
  const clock = overrides.clock ?? createFakeClock();
  return {
    exporter: consumer,
    clock,
    staticContext: overrides.staticContext ?? {},
    dynamicContext: overrides.dynamicContext ?? null,
    currentPage: overrides.currentPage ?? null,
    enterStack: new ActiveEnterStack(),
    stepStack: [],
    seq: overrides.seq ?? 0,
    startedAt: overrides.startedAt ?? 0,
    events: events as unknown as any[],
  };
}

// Re-export the fake clock so tests that only need a clock can pull
// it from this helper instead of digging into the harness.
export { createFakeClock } from './trace-event-recorder-harness';
