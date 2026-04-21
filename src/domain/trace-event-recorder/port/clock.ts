/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 *
 */

// Clock — port (interface) for the time source the recorder uses.
//
// A clock is a plain object implementing:
//
//   now() → number
//     Returns the current time as a monotonic millisecond value.
//     Only differences between two `now()` readings are meaningful —
//     the absolute origin is irrelevant. Used by the recorder to
//     compute each event's `t` (time since reset) and each ok/throw's
//     `duration` (time since the paired enter).
//
//   wallNow() → number
//     Returns the current wall-clock time as a Unix epoch millisecond
//     value. Used for the meta event's absolute `wallTime` stamp, so
//     traces are anchored to real time for reporting. Kept separate
//     from `now()` because monotonic clocks have an arbitrary origin.
//
// Adapters in ../adapters/ implement this contract. The default
// recorder wires `PerfHooksClock` which wraps
// `perf_hooks.performance.now()`. Tests inject their own clock with
// `createFakeClock()` so assertions on duration become deterministic.

export interface Clock {
  now(): number;
  wallNow(): number;
}
