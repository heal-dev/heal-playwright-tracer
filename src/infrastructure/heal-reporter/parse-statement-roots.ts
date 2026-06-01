/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import * as fs from 'fs';

import type { FailingStatement } from '../../domain/persistence';
import type { Statement } from '../../domain/trace-event-recorder/model/statement-trace-schema';

// Read the root `statement` records from a `heal-traces.ndjson` file, in
// emission order. Nested calls live in each statement's `children`.
// Tolerates a torn last line (mirrors `NdjsonTailInspector`). Returns
// `[]` when the file is unreadable. Shared by both the location-based
// and scope-grouping failure finders.
export function parseStatementRoots(ndjsonPath: string): Statement[] {
  let body: string;
  try {
    body = fs.readFileSync(ndjsonPath, 'utf8');
  } catch {
    return [];
  }

  const roots: Statement[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: { kind?: unknown; statement?: Statement } | null;
    try {
      parsed = JSON.parse(trimmed) as { kind?: unknown; statement?: Statement };
    } catch {
      // Tolerate torn last line (mirrors `NdjsonTailInspector`).
      continue;
    }
    if (parsed?.kind !== 'statement' || !parsed.statement) continue;
    roots.push(parsed.statement);
  }
  return roots;
}

// Project a full `Statement` down to the persisted `FailingStatement`
// locator. Shared so both finders emit an identical shape.
export function projectFailingStatement(stmt: Statement): FailingStatement {
  return {
    index: stmt.index,
    file: stmt.file,
    line: stmt.line,
    endLine: stmt.endLine,
    source: stmt.source,
    scope: stmt.scope,
    step: stmt.step,
    stepPath: stmt.stepPath,
  };
}
