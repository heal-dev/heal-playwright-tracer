// HealTraceSink — port for where projected trace records (as opposed
// to raw recorder events) go.
//
// A HealTraceSink consumes `HealTraceRecord`s produced by the
// statement projector (../projectors/statement-projector.ts). One
// record per `write()` call. The sink decides how to transport
// them: append to a file (NdjsonSink), POST to a local agent
// (AgentHttpSink), or fan out to several backends (TeeSink).
//
// `close()` flushes anything buffered and releases resources (file
// handles, in-flight requests). It MUST be called at test teardown;
// adapters that buffer in memory will lose events otherwise.
//
// Adapters MUST NOT mutate the records they receive. Records are
// plain JSON-serializable objects.

import type { HealTraceRecord } from '../../features/trace-output/statement-trace-schema';

export type { HealTraceRecord };

export interface HealTraceSink {
  write(record: HealTraceRecord): void;
  close(): Promise<void>;
}
