// Default trace-event-recorder instance — the side-effect entrypoint.
//
// `./factory.ts` exports `createTraceEventRecorder()` — a pure
// factory that takes a `sink` (TraceSink port) and a `clock` (Clock
// port). This file is the thin wrapper that:
//
//   1. Builds one trace-event-recorder with the default MemorySink +
//      PerfHooksClock.
//   2. Installs `globalThis.__heal_enter/__heal_ok/__heal_throw` so the
//      Babel-inserted calls find them at runtime.
//   3. Gathers the static per-process context (pid, gitSha, …) that
//      used to be inlined here.
//   4. Re-exports the public API in its historical shape so nothing
//      downstream (features/, fixture/, consumers of
//      heal-playwright-tracer/trace-event-recorder) has to change.
//
// Tests do NOT import this file — they import `./factory` directly
// and inject a MemorySink + fake clock to keep assertions
// deterministic.

import * as os from 'os';
import { execSync } from 'child_process';
import { createTraceEventRecorder, SCHEMA_VERSION } from './factory';

const staticContext: Record<string, unknown> = {
  schemaVersion: SCHEMA_VERSION,
  pid: process.pid,
  nodeVersion: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  hostname: os.hostname(),
  isCI: !!process.env.CI,
  cwd: process.cwd(),
};

// Git SHA read once, best-effort.
try {
  staticContext.gitSha = execSync('git rev-parse HEAD', {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .toString()
    .trim();
} catch (_) {
  // not a git repo / git not installed — leave undefined
}

const traceEventRecorder = createTraceEventRecorder({ staticContext });

// Public contract names are prefixed with `__heal_` so anyone reading
// the babel-transformed test source understands at a glance which
// library these hooks belong to. The factory's internal method names
// (`__enter`, `__ok`, `__throw`) are unchanged — they never leak into
// user-facing code.
(globalThis as unknown as { __heal_enter: typeof traceEventRecorder.__enter }).__heal_enter =
  traceEventRecorder.__enter;
(globalThis as unknown as { __heal_ok: typeof traceEventRecorder.__ok }).__heal_ok =
  traceEventRecorder.__ok;
(globalThis as unknown as { __heal_throw: typeof traceEventRecorder.__throw }).__heal_throw =
  traceEventRecorder.__throw;

export const reset = traceEventRecorder.reset;
export const snapshot = traceEventRecorder.snapshot;
export const setContext = traceEventRecorder.setContext;
export const setPage = traceEventRecorder.setPage;
export const pushStep = traceEventRecorder.pushStep;
export const popStep = traceEventRecorder.popStep;
export const setCurrentStatementScreenshot = traceEventRecorder.setCurrentStatementScreenshot;
export const setSink = traceEventRecorder.setSink;
export { SCHEMA_VERSION };
