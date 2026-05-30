/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Locates the statement responsible for a test failure inside one
// `heal-traces.ndjson`, used by `HealTracerReporter.onTestEnd`.
//
// Walk root statements in file order; return the deepest `threw`
// inside the FIRST root that has an uncaught throw (a `threw` whose
// ancestor chain is all `threw` — i.e. not swallowed by a try/catch).
// First-root semantics: body throw beats afterEach collateral throw.

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

      // Roots have no parent → seed `ancestorChainAllThrew=true`.
      const found = findDeepestUncaughtThrew(parsed.statement, 0, true);
      if (found && found.stmt.error) {
        return {
          statement: project(found.stmt),
          error: found.stmt.error,
        };
      }
    }

    return null;
  }
}

// Deepest `threw` whose ancestor chain is all `threw`. Children
// inherit the all-threw chain only if we ourselves threw; if we
// returned `ok` despite a child throwing, the catch sits in us.
function findDeepestUncaughtThrew(
  stmt: Statement,
  depth: number,
  ancestorChainAllThrew: boolean,
): { stmt: Statement; depth: number } | null {
  const propagated = stmt.status === 'threw' && ancestorChainAllThrew;
  let best: { stmt: Statement; depth: number } | null = propagated ? { stmt, depth } : null;

  const childChainAllThrew = ancestorChainAllThrew && stmt.status === 'threw';
  for (const child of stmt.children) {
    const found = findDeepestUncaughtThrew(child, depth + 1, childChainAllThrew);
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
