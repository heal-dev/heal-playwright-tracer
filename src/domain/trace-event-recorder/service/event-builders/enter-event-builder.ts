/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 *
 */

// Builds the `{ type: 'enter', ... }` event emitted every time the
// Babel-injected `__enter(meta)` call fires at the start of a
// traced statement.
//
// Reads from state:
//   - enterStack.depth() / parentSeq() — to stamp this event's
//     position in the currently-active call tree.
//   - clock.now() - startedAt          — for the relative `t` field.
//   - stepStack                        — so every enter carries the
//                                        innermost test.step title and
//                                        the full step path.
//   - currentPage                      — tolerant page.url() read.
//
// Writes to state:
//   - ++seq
//   - enterStack.push(event) — the recorder needs this to match the
//     subsequent __ok/__throw and derive `duration` at that point.
//   - exporter.write(event)

import type { TraceEventRecorderState } from '../trace-event-recorder-state';
import type { EnterMeta } from '../../model/enter-meta';
import type { EnterEvent } from '../../model/trace-schema';

// Tolerant page.url() read. Playwright pages throw on closed/detached
// contexts, and any such failure here must not corrupt the trace.
function safePageUrl(currentPage: unknown): string | undefined {
  const pg = currentPage as { url?: () => string } | null;
  if (!pg || typeof pg.url !== 'function') return undefined;
  try {
    return pg.url();
  } catch (_) {
    return undefined;
  }
}

export function buildEnterEvent(state: TraceEventRecorderState, meta: EnterMeta): void {
  const event: EnterEvent = {
    type: 'enter',
    seq: ++state.seq,
    parentSeq: state.enterStack.parentSeq(),
    depth: state.enterStack.depth(),
    t: state.clock.now() - state.startedAt,
    wallTime: Date.now(),
    ...meta,
    step: state.stepStack.length ? state.stepStack[state.stepStack.length - 1] : null,
    stepPath: state.stepStack.length ? state.stepStack.slice() : null,
    pageUrl: safePageUrl(state.currentPage),
  };
  state.enterStack.push(event);
  state.exporter.write(event);
}
