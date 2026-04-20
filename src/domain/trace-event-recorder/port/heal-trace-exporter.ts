// HealTraceExporter — port for where projected trace records (as opposed
// to raw recorder events) go.
//
// A HealTraceExporter consumes `HealTraceRecord`s produced by the
// statement projector (../service/projectors/statement-projector.ts). One
// record per `write()` call. The exporter decides how to transport
// them: append to a file (NdjsonExporter), POST to a local agent
// (AgentHttpExporter), or fan out to several backends
// (CompositeHealTraceExporter).
//
// `close()` flushes anything buffered and releases resources (file
// handles, in-flight requests). It MUST be called at test teardown;
// adapters that buffer in memory will lose events otherwise.
//
// Adapters MUST NOT mutate the records they receive. Records are
// plain JSON-serializable objects.

import type { HealTraceRecord } from '../model/statement-trace-schema';

export type { HealTraceRecord };

export interface HealTraceExporter {
  write(record: HealTraceRecord): void;
  close(): Promise<void>;
}
