/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */

import type { TraceEventConsumer } from '../port/trace-event-consumer';
import type { Clock } from '../port/clock';
import type { ActiveEnterStack } from './active-enter-stack';

export interface TraceEventRecorderState {
  // Injected dependencies.
  exporter: TraceEventConsumer;
  clock: Clock;

  // Per-process static context (pid, gitSha, …) — merged into every
  // meta event emitted by reset().
  staticContext: Record<string, unknown>;

  // Per-test dynamic context set via setContext() — merged into
  // every meta event. Cleared to null between runs.
  dynamicContext: Record<string, unknown> | null;

  // The Playwright page associated with the current test. Used by
  // the enter-event-builder to attach `pageUrl` to every enter event.
  currentPage: unknown;

  // The active-enter stack — pairs each __enter with its matching
  // __ok/__throw and derives `depth` and `parentSeq` for the
  // currently-running statement.
  enterStack: ActiveEnterStack;

  // Nested test.step titles pushed via pushStep/popStep.
  stepStack: string[];

  // Monotonically increasing sequence number, stamped on every event.
  seq: number;

  // Origin for relative `t` values. Reset at the start of every run
  // so each trace begins at t=0.
  startedAt: number;
}
