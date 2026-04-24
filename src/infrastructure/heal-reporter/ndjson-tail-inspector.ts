/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Checks whether an on-disk `heal-traces.ndjson` already ends with a
// `test-result` record. Used by `HealTracerReporter.onTestEnd` to
// decide whether the fixture's own `projector.finalize(...)` reached
// disk — if it did, the reporter is a no-op; if it didn't, it
// appends a synthetic `test-result` to terminate the file.
//
// Torn-write tolerance: a crash mid-`fs.writeSync` can leave a
// partial JSON object on the last line. `JSON.parse` failures are
// treated as "not terminated" — the reporter will then append its
// own terminator, and consumers who encounter the torn line follow
// the schema rule of discarding any trailing non-parseable line.

import * as fs from 'fs';

export class NdjsonTailInspector {
  endsWithTestResult(filePath: string): boolean {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      return false;
    }
    const lastLine = content.trimEnd().split('\n').at(-1) ?? '';
    if (lastLine.length === 0) return false;
    try {
      const parsed = JSON.parse(lastLine) as { kind?: unknown };
      return parsed.kind === 'test-result';
    } catch {
      return false;
    }
  }
}
