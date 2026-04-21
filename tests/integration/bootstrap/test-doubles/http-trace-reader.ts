/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

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
