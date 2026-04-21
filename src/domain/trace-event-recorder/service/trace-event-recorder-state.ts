/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 *
 */

// TraceEventRecorderState — the mutable state held by a single
// trace-event-recorder instance.
//
// Every event builder in ./event-builders/ takes a reference to this
// shape, reads/mutates what it needs, and writes the resulting event
// to `state.exporter`. Keeping the state in one explicitly-typed
// interface (instead of closing it over inside a class's private
// fields alone) is what lets each event builder live in its own
// file and be unit-tested with a stub state.
//
// The interface is implemented by the `TraceEventRecorder` class
// itself — the class fields ARE the state, not a wrapped object.

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
