// NdjsonSink — HealTraceSink adapter that appends one JSON record
// per line to a file on disk.
//
// Designed to be crash-safe: every `write()` calls `fs.writeSync()`
// so the record is on disk before the call returns. If the test
// process is SIGKILL'd one instruction later the file still
// contains every record written up to that point. This is the
// durable record of truth; the live agent path (AgentHttpSink) is
// best-effort and may lose its tail on crash.
//
// The file descriptor is opened in the constructor and closed by
// `close()`. Callers MUST call `close()` at test teardown; omitting
// it leaks the fd but does not lose data (writes were already
// flushed line-by-line).

import * as fs from 'fs';
import type { HealTraceSink, HealTraceRecord } from '../ports/heal-trace-sink';

export function createNdjsonSink(filePath: string): HealTraceSink {
  // O_APPEND so concurrent appenders (not expected, but cheap) are
  // safe and so truncation on reopen never happens.
  const fd = fs.openSync(filePath, 'a');
  let closed = false;

  return {
    write(record: HealTraceRecord) {
      if (closed) return;
      fs.writeSync(fd, JSON.stringify(record) + '\n');
    },
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      fs.closeSync(fd);
      return Promise.resolve();
    },
  };
}
