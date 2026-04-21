/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 *
 */

// TraceEventRecorder — the domain service that records every
// Babel-instrumented statement as a stream of trace events.
//
// Dependencies are injected:
//
//   exporter : TraceEventConsumer — where events go. REQUIRED. The
//              composition root in `application/trace-event-recorder-runtime`
//              supplies a bootstrap no-op exporter; the fixture
//              replaces it per test via `setExporter(projector)`;
//              tests pass a `TraceEventConsumerStub` from `tests/helpers/`.
//   clock    : Clock — monotonic ms time source (see ports/clock.ts).
//              REQUIRED. The composition root wires PerfHooksClock;
//              tests pass a fake clock.
//
// Public methods that callers capture unbound (e.g. assigned to
// `globalThis.__heal_enter` by the runtime, or re-exported from the
// runtime module as `export const reset = recorder.reset`) are
// declared as arrow-function fields so `this` stays correct no
// matter how they are extracted.
//
// This class installs nothing on `globalThis` — that is the
// composition root's job.

import type { TraceEventConsumer } from '../port/trace-event-consumer';
import type { Clock } from '../port/clock';
import { ActiveEnterStack } from './active-enter-stack';
import type { TraceEventRecorderState } from './trace-event-recorder-state';
import type { EnterMeta } from '../model/enter-meta';
import { SCHEMA_VERSION } from '../model/trace-schema';
import { buildEnterEvent } from './event-builders/enter-event-builder';
import { buildOkEvent } from './event-builders/ok-event-builder';
import { buildThrowEvent } from './event-builders/throw-event-builder';
import { buildMetaEvent } from './event-builders/meta-event-builder';

export { SCHEMA_VERSION };
export type { Clock } from '../port/clock';
export type { EnterMeta } from '../model/enter-meta';

export interface CreateTraceEventRecorderOptions {
  exporter: TraceEventConsumer;
  clock: Clock;
  staticContext?: Record<string, unknown>;
}

export class TraceEventRecorder implements TraceEventRecorderState {
  readonly SCHEMA_VERSION = SCHEMA_VERSION;

  exporter: TraceEventConsumer;
  readonly clock: Clock;
  readonly staticContext: Record<string, unknown>;
  dynamicContext: Record<string, unknown> | null = null;
  currentPage: unknown = null;
  readonly enterStack: ActiveEnterStack = new ActiveEnterStack();
  readonly stepStack: string[] = [];
  seq = 0;
  startedAt: number;

  constructor(options: CreateTraceEventRecorderOptions) {
    this.exporter = options.exporter;
    this.clock = options.clock;
    this.staticContext = options.staticContext ?? {};
    this.startedAt = this.clock.now();
  }

  /**
   * Swap the active exporter for subsequent events. Used by the fixture
   * to install a fresh projector+tee at the start of every test —
   * that way each test has an isolated output pipeline without the
   * recorder having to be rebuilt. The caller is responsible for
   * flushing/closing the previous exporter if needed.
   */
  setExporter = (newExporter: TraceEventConsumer): void => {
    this.exporter = newExporter;
  };

  reset = (): void => {
    this.exporter.clear();
    this.enterStack.clear();
    this.seq = 0;
    this.startedAt = this.clock.now();
    buildMetaEvent(this);
  };

  setContext = (ctx: Record<string, unknown> | null): void => {
    this.dynamicContext = ctx ?? null;
  };

  setPage = (page: unknown | null): void => {
    this.currentPage = page ?? null;
  };

  pushStep = (name: string): void => {
    this.stepStack.push(name);
  };

  popStep = (): void => {
    this.stepStack.pop();
  };

  /**
   * Stamp a highlight screenshot filename onto whatever enter event
   * is currently on top of the active-enter stack. Called by the
   * locator-screenshots feature right after it writes the PNG to
   * disk. No-op if the stack is empty (screenshot fired outside any
   * instrumented statement, e.g. before the first __enter).
   */
  setCurrentStatementScreenshot = (filename: string): void => {
    const top = this.enterStack.peek();
    if (top) top.screenshot = filename;
  };

  __enter = (meta: EnterMeta): void => {
    buildEnterEvent(this, meta);
  };

  __ok = (vars?: unknown): void => {
    buildOkEvent(this, vars);
  };

  __throw = (err: unknown): void => {
    buildThrowEvent(this, err);
  };
}
