/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

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
