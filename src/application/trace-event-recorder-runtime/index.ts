/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */

import { TraceEventRecorder, SCHEMA_VERSION } from '../../domain/trace-event-recorder/service';
import type { TraceEventConsumer } from '../../domain/trace-event-recorder/port/trace-event-consumer';
import { PerfHooksClock } from '../../infrastructure/perf-hooks-clock-adapter';
import { SystemInfoAdapter } from '../../infrastructure/system-info-adapter';
import {
  HEAL_ENTER,
  HEAL_OK,
  HEAL_THROW,
} from '../../domain/trace-event-recorder/model/global-names';

// See the header comment: the recorder is constructed at module load
// and MUST have an exporter from that moment so any pre-fixture
// `__heal_enter` call doesn't crash. The fixture replaces this with
// the real per-test projector via `setExporter(...)`.
const BOOTSTRAP_EXPORTER: TraceEventConsumer = {
  write() {},
  clear() {},
};

const systemInfo = new SystemInfoAdapter().getStaticContext();
const staticContext: Record<string, unknown> = {
  schemaVersion: SCHEMA_VERSION,
  ...systemInfo,
};

const traceEventRecorder = new TraceEventRecorder({
  exporter: BOOTSTRAP_EXPORTER,
  clock: new PerfHooksClock(),
  staticContext,
});

// Global-name contract lives in `domain/.../model/global-names.ts`,
// shared with the Babel plugin that emits calls to these names. The
// factory's internal method names (`__enter`, `__ok`, `__throw`) are
// unchanged — they never leak into user-facing code.
const g = globalThis as unknown as Record<string, unknown>;
g[HEAL_ENTER] = traceEventRecorder.__enter;
g[HEAL_OK] = traceEventRecorder.__ok;
g[HEAL_THROW] = traceEventRecorder.__throw;

export const reset = traceEventRecorder.reset;
export const setContext = traceEventRecorder.setContext;
export const setPage = traceEventRecorder.setPage;
export const pushStep = traceEventRecorder.pushStep;
export const popStep = traceEventRecorder.popStep;
export const setCurrentStatementScreenshot = traceEventRecorder.setCurrentStatementScreenshot;
export const setExporter = traceEventRecorder.setExporter;
export { SCHEMA_VERSION };
