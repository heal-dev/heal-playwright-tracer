// PerfHooksClock — the default Clock adapter.
//
// Wraps `perf_hooks.performance.now()`, the high-resolution monotonic
// clock Node exposes. Millisecond precision with sub-millisecond
// fractional digits; unaffected by wall-clock adjustments (NTP,
// daylight savings). This is what production recording uses.
//
// Tests do NOT use this adapter — they construct their own
// `createFakeClock()` and pass it to `createTraceEventRecorder({ clock })`.

import type { Clock } from '../ports/clock';

export function createPerfHooksClock(): Clock {
  // Lazy require so pulling this adapter in doesn't eagerly load
  // perf_hooks in environments that don't need it.

  const { performance } = require('perf_hooks') as typeof import('perf_hooks');
  return { now: () => performance.now() };
}
