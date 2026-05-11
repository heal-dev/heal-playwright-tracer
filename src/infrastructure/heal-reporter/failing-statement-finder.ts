/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Locates the statement responsible for a test failure inside one
// `heal-traces.ndjson`. Used by `HealTracerReporter.onTestEnd` to
// surface a compact `FailingStatement` + `StatementError` on each
// attempt of the `execution.json` manifest.
//
// "Failing statement" = the deepest node in any root `statement`
// record's children tree whose `status === 'threw'`. Going deepest
// rather than first-seen surfaces the actual leaf call that threw
// (e.g. `page.locator(...).click()`) instead of the enclosing user
// step that propagated the error up.
//
// Returns null when the file is missing/torn, no statement threw,
// or the statement that threw has no error attached (defensive — the
// schema requires `error` on `status === 'threw'` but we tolerate
// older traces).

import * as fs from 'fs';

import type { FailingStatement } from '../../domain/persistence';
import type {
  Statement,
  StatementError,
} from '../../domain/trace-event-recorder/model/statement-trace-schema';

export interface FoundFailure {
  statement: FailingStatement;
  error: StatementError;
}

export class FailingStatementFinder {
  find(ndjsonPath: string): FoundFailure | null {
    let body: string;
    try {
      body = fs.readFileSync(ndjsonPath, 'utf8');
    } catch {
      return null;
    }

    let deepest: { stmt: Statement; depth: number } | null = null;
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: { kind?: unknown; statement?: Statement } | null;
      try {
        parsed = JSON.parse(trimmed) as { kind?: unknown; statement?: Statement };
      } catch {
        // Torn-write tolerance: skip unparseable lines. Mirrors the
        // discipline of `NdjsonTailInspector`.
        continue;
      }
      if (parsed?.kind !== 'statement' || !parsed.statement) continue;

      const found = findDeepestThrew(parsed.statement, 0);
      if (found && (!deepest || found.depth > deepest.depth)) {
        deepest = found;
      }
    }

    if (!deepest || !deepest.stmt.error) return null;

    return {
      statement: project(deepest.stmt),
      error: deepest.stmt.error,
    };
  }
}

function findDeepestThrew(
  stmt: Statement,
  depth: number,
): { stmt: Statement; depth: number } | null {
  let best: { stmt: Statement; depth: number } | null =
    stmt.status === 'threw' ? { stmt, depth } : null;
  for (const child of stmt.children) {
    const found = findDeepestThrew(child, depth + 1);
    if (found && (!best || found.depth > best.depth)) {
      best = found;
    }
  }

  return best;
}

function project(stmt: Statement): FailingStatement {
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
