/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 *
 */

// NdjsonExporter — HealTraceExporter adapter that appends one JSON record
// per line to a file on disk.
//
// Designed to be crash-safe: every `write()` calls `fs.writeSync()`
// so the record is on disk before the call returns. If the test
// process is SIGKILL'd one instruction later the file still
// contains every record written up to that point. This is the
// durable record of truth; the live agent path (AgentHttpExporter) is
// best-effort and may lose its tail on crash.
//
// The file descriptor is opened in the constructor and closed by
// `close()`. Callers MUST call `close()` at test teardown; omitting
// it leaks the fd but does not lose data (writes were already
// flushed line-by-line).

import * as fs from 'fs';
import type {
  HealTraceExporter,
  HealTraceRecord,
} from '../../domain/trace-event-recorder/port/heal-trace-exporter';

export class NdjsonExporter implements HealTraceExporter {
  private readonly fd: number;
  private closed = false;

  constructor(filePath: string) {
    // O_APPEND so concurrent appenders (not expected, but cheap) are
    // safe and so truncation on reopen never happens.
    this.fd = fs.openSync(filePath, 'a');
  }

  write(record: HealTraceRecord): void {
    if (this.closed) return;
    fs.writeSync(this.fd, JSON.stringify(record) + '\n');
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    fs.closeSync(this.fd);
    return Promise.resolve();
  }
}
