/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */

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
