/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 *
 */

// PerfHooksClock — the default Clock adapter.
//
// Wraps `perf_hooks.performance.now()`, the high-resolution monotonic
// clock Node exposes. Millisecond precision with sub-millisecond
// fractional digits; unaffected by wall-clock adjustments (NTP,
// daylight savings). This is what production recording uses.
//
// `wallNow()` reads `Date.now()` — a separate Unix-epoch wall clock
// used by the meta event's absolute start timestamp.
//
// Tests do NOT use this adapter — they construct their own
// `createFakeClock()` and pass it to `new TraceEventRecorder({ clock })`.

import type { Clock } from '../../domain/trace-event-recorder/port/clock';

export class PerfHooksClock implements Clock {
  // Lazy require so pulling this adapter in doesn't eagerly load
  // perf_hooks in environments that don't need it.
  private readonly performance: typeof import('perf_hooks').performance = (
    require('perf_hooks') as typeof import('perf_hooks')
  ).performance;

  now(): number {
    return this.performance.now();
  }

  wallNow(): number {
    return Date.now();
  }
}
