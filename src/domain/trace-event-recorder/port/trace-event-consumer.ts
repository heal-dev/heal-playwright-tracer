/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 *
 */

// TraceEventConsumer — port for anything that consumes the raw
// `TraceEvent` stream emitted by the trace-event-recorder.
//
// The `StatementProjector` (service/projectors) is the only
// production consumer; its role is to transform raw events into the
// projected `HealTraceRecord` stream. In tests an in-memory stub
// (`tests/helpers/trace-event-consumer-stub.ts`) implements the
// same interface for event-builder assertions.
//
// Contract:
//
//   - `write(event)` — called once per recorder event, in the order
//     they fire.
//   - `clear()`      — called by the recorder's `reset()` between
//     tests, so consumers with per-test state can wipe it.
//
// No `snapshot()` on the port: only tests need to inspect the buffer,
// and the stub exposes the captured `events` array as a side-channel
// (not a method). That way the port contains strictly the methods
// production calls.

import type { TraceEvent } from '../model/trace-schema';

export type { TraceEvent };

export interface TraceEventConsumer {
  write(event: TraceEvent): void;
  clear(): void;
}
