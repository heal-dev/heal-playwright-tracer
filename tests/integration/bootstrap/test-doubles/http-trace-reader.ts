// HTTP reader — reads completed traces from `StubCollectorServer`'s
// in-memory batches.
//
// Each batch corresponds to one test (the user-side stub-exporter
// flushes once per test on `close()`), so demuxing by testId is
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
