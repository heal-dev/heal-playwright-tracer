// Trace-event-recorder factory — the composition root.
//
// `createTraceEventRecorder({ sink?, clock?, staticContext? })`
// returns a trace-event-recorder instance with all the state-holding
// functions (__enter, __ok, __throw, reset, snapshot, setContext,
// setPage, pushStep, popStep, setCurrentStatementScreenshot).
//
// This file is the composition root. It creates the
// TraceEventRecorderState, wires up default adapters for any
// dependency the caller didn't provide, and dispatches each public
// method to the appropriate event builder. Reading this file
// top-to-bottom tells you the full trace-event-recorder API and
// where each method's logic lives.
//
// Dependencies are injected for testability:
//
//   sink   : TraceSink — where events go (see ports/trace-sink.ts).
//            Defaults to a fresh MemorySink.
//   clock  : Clock — monotonic ms time source (see ports/clock.ts).
//            Defaults to PerfHooksClock (wraps perf_hooks.performance).
//
// Tests construct their own sink + clock and pass them in so
// snapshot assertions become fully deterministic.
//
// This module installs nothing on `globalThis` — that is the
// default trace-event-recorder's job (./entrypoint.ts).

import type { TraceEvent, TraceSink } from './ports/trace-sink';
import type { Clock } from './ports/clock';
import { createMemorySink } from './adapters/memory-sink';
import { createPerfHooksClock } from './adapters/perf-hooks-clock';
import { createActiveEnterStack } from './active-enter-stack';
import { type TraceEventRecorderState, type EnterMeta, SCHEMA_VERSION } from './state';
import { buildEnterEvent } from './event-builders/enter-event-builder';
import { buildOkEvent } from './event-builders/ok-event-builder';
import { buildThrowEvent } from './event-builders/throw-event-builder';
import { buildMetaEvent } from './event-builders/meta-event-builder';

export { SCHEMA_VERSION };
export type { Clock } from './ports/clock';
export type { EnterMeta } from './state';

export interface CreateTraceEventRecorderOptions {
  sink?: TraceSink;
  clock?: Clock;
  staticContext?: Record<string, unknown>;
}

export interface TraceEventRecorder {
  SCHEMA_VERSION: number;
  sink: TraceSink;
  /**
   * Swap the active sink for subsequent events. Used by the fixture
   * to install a fresh projector+tee at the start of every test —
   * that way each test has an isolated output pipeline without the
   * recorder having to be rebuilt. The caller is responsible for
   * flushing/closing the previous sink if needed.
   */
  setSink(sink: TraceSink): void;
  reset(): void;
  snapshot(): TraceEvent[];
  setContext(ctx: Record<string, unknown> | null): void;
  setPage(page: unknown | null): void;
  pushStep(name: string): void;
  popStep(): void;
  /**
   * Stamp a highlight screenshot filename onto whatever enter event
   * is currently on top of the active-enter stack. Called by the
   * locator-screenshots feature right after it writes the PNG to
   * disk. No-op if the stack is empty (screenshot fired outside any
   * instrumented statement, e.g. before the first __enter).
   */
  setCurrentStatementScreenshot(filename: string): void;
  __enter(meta: EnterMeta): void;
  __ok(vars?: unknown): void;
  __throw(err: unknown): void;
}

export function createTraceEventRecorder(
  options: CreateTraceEventRecorderOptions = {},
): TraceEventRecorder {
  const sink = options.sink ?? createMemorySink();
  const clock = options.clock ?? createPerfHooksClock();

  const state: TraceEventRecorderState = {
    sink,
    clock,
    staticContext: options.staticContext ?? {},
    dynamicContext: null,
    currentPage: null,
    enterStack: createActiveEnterStack(),
    stepStack: [],
    seq: 0,
    startedAt: clock.now(),
  };

  return {
    SCHEMA_VERSION,
    sink,

    setSink(newSink) {
      state.sink = newSink;
    },

    reset() {
      state.sink.clear();
      state.enterStack.clear();
      state.seq = 0;
      state.startedAt = clock.now();
      buildMetaEvent(state);
    },

    snapshot() {
      return state.sink.snapshot();
    },

    setContext(ctx) {
      state.dynamicContext = ctx ?? null;
    },

    setPage(page) {
      state.currentPage = page ?? null;
    },

    pushStep(name) {
      state.stepStack.push(name);
    },

    popStep() {
      state.stepStack.pop();
    },

    setCurrentStatementScreenshot(filename) {
      const top = state.enterStack.peek();
      if (top) top.screenshot = filename;
    },

    __enter(meta) {
      buildEnterEvent(state, meta);
    },

    __ok(vars) {
      buildOkEvent(state, vars);
    },

    __throw(err) {
      buildThrowEvent(state, err);
    },
  };
}
