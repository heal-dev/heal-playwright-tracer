// Disk reader — reads completed traces by walking the sandbox's
// `test-results/` tree for `heal-traces.ndjson` files.
//
// This proves the always-on default exporter (NDJSON, written via
// `NdjsonExporter` in the composition root) works end-to-end. One
// file per test, parsed line-by-line into a `ParsedTrace`.

import * as fs from 'fs';
import * as path from 'path';
import type { HealTraceRecord } from '../../../../src/domain/trace-event-recorder/model/statement-trace-schema';
import { type ParsedTrace, assembleTrace } from '../../fixtures/parsed-trace';

function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

export class DiskTraceReader {
  collect(sandboxRoot: string): Map<string, ParsedTrace> {
    const traces = new Map<string, ParsedTrace>();
    const testResultsDir = path.join(sandboxRoot, 'test-results');
    for (const file of walkFiles(testResultsDir)) {
      if (!file.endsWith('heal-traces.ndjson')) continue;
      const records = parseNdjson(file);
      const parsed = assembleTrace(records);
      if (parsed) traces.set(parsed.test.title, parsed);
    }
    return traces;
  }
}

function parseNdjson(filePath: string): HealTraceRecord[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as HealTraceRecord);
}
