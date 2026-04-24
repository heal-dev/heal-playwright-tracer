/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Checks whether an on-disk `heal-traces.ndjson` already ends with a
// `test-result` record.
//
// Used by `HealTracerReporter.onTestEnd` to decide whether the
// fixture's own `projector.finalize(...)` reached disk. If it did
// (clean teardown), the reporter is a no-op; if it didn't (worker
// crashed before finalize), the reporter appends a synthetic
// `test-result` to terminate the file.
//
// Why tail-only: a completed NDJSON can easily be hundreds of KB
// (stdout/stderr payloads inline). Reading the whole file every time
// would waste I/O. The last record is always short — even with a
// large stderr payload, it lands in the 4 KB tail we read. If the
// tail is too small to contain the final newline + record, we fall
// back to reading the whole file.
//
// Torn-write tolerance: a crash mid-`fs.writeSync` can leave a
// partial JSON object on the last line. We `JSON.parse` inside a
// try/catch and treat parse failures as "not terminated" — the
// reporter will then append its own terminator, and consumers who
// encounter the torn line must follow the schema rule of discarding
// any trailing non-parseable line.

import * as fs from 'fs';

const TAIL_BYTES = 4096;

export class NdjsonTailInspector {
  endsWithTestResult(filePath: string): boolean {
    let buffer: Buffer;
    let fd: number;
    try {
      fd = fs.openSync(filePath, 'r');
    } catch {
      return false;
    }
    try {
      const size = fs.fstatSync(fd).size;
      if (size === 0) return false;
      const readBytes = Math.min(size, TAIL_BYTES);
      buffer = Buffer.alloc(readBytes);
      fs.readSync(fd, buffer, 0, readBytes, size - readBytes);
    } finally {
      fs.closeSync(fd);
    }

    const text = buffer.toString('utf8');
    const lastNewline = text.lastIndexOf('\n', text.length - 2);
    const candidate = (lastNewline >= 0 ? text.slice(lastNewline + 1) : text).trim();
    if (candidate.length === 0) return false;

    try {
      const parsed = JSON.parse(candidate) as { kind?: unknown };
      return parsed.kind === 'test-result';
    } catch {
      return false;
    }
  }
}
