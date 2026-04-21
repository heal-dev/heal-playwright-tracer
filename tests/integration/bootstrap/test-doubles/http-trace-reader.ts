/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */
// HTTP reader — reads completed traces from `StubCollectorServer`'s
// in-memory batches.
//
// Each batch corresponds to one test (the user-side stub-exporter
// flushes once per test on `close()`), so demuxing by `runId` is
// unnecessary: each batch maps directly to one `ParsedTrace`.

import { type ParsedTrace, assembleTrace } from '../../fixtures/parsed-trace';
import type { StubCollectorServer } from './stub-collector-server';

export class HttpTraceReader {
  collect(server: StubCollectorServer): Map<string, ParsedTrace> {
    const traces = new Map<string, ParsedTrace>();
    for (const batch of server.received()) {
      const parsed = assembleTrace(batch.records);
      if (parsed) traces.set(parsed.test.title, parsed);
    }
    return traces;
  }
}
