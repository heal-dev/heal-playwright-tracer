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
// Adapters in ../adapters/ implement this contract. The default
// recorder wires `PerfHooksClock` which wraps
// `perf_hooks.performance.now()`. Tests inject their own clock with
// `createFakeClock()` so assertions on duration become deterministic.

export interface Clock {
  now(): number;
}
