/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// FALLBACK failure locator, used by `HealTracerReporter.onTestEnd` when
// Playwright did not give us a usable error location (worker crash,
// timeout with no user frame, a failure in a non-instrumented file). The
// PRIMARY path is `LocationBasedFailureFinder`, which maps Playwright's
// `result.errors[].location` straight onto a recorded statement; this
// scope-shape heuristic only runs when that returns nothing.
//
// Locates the statement responsible for a test failure inside one
// `heal-traces.ndjson` purely from the trace's own `ok`/`threw` shape.
//
// Group root statements by `scope` (test body / beforeEach / afterEach /
// …). Walk groups in encounter order. The first group whose LAST root
// is `threw` is where the test crashed — within that root, drill to the
// deepest `threw` whose ancestor chain is also `threw` (handles helper
// internal try/catch).
//
// Why "last in scope": when source has `try { await x(); } catch {}`,
// the tracer still records `await x()` as `threw` (the throw was
// emitted before JS routed to the catch), but execution continues and
// the next root statement runs (`ok`). So a caught-by-source throw
// always has a following root in the same scope; a real failure halts
// execution and is the last thing in its scope. Body-vs-afterEach:
// body crash halts the body scope group; afterEach runs in its own
// group — first crashing group wins, so body beats afterEach collateral.
//
// Limitation: a test scope ending in a source-level `try{}catch{}`
// with no following code can't be distinguished from a real crash on
// trace alone. Long-term fix is AST-tagging statements lexically
// inside try/catch at trace ingest. Rare in practice.

import type { FailingStatement } from '../../domain/persistence';
import type {
  Statement,
  StatementError,
} from '../../domain/trace-event-recorder/model/statement-trace-schema';
import { parseStatementRoots, projectFailingStatement } from './parse-statement-roots';

export interface FoundFailure {
  statement: FailingStatement;
  error: StatementError;
}

export class FailingStatementFinder {
  find(ndjsonPath: string): FoundFailure | null {
    const roots = parseStatementRoots(ndjsonPath);

    // Walk consecutive same-scope groups. First group whose last root
    // is `threw` is the crashing scope.
    let groupStart = 0;
    while (groupStart < roots.length) {
      const groupScope = roots[groupStart].scope;
      let groupEnd = groupStart + 1;
      while (groupEnd < roots.length && roots[groupEnd].scope === groupScope) {
        groupEnd++;
      }
      const lastInGroup = roots[groupEnd - 1];
      if (lastInGroup.status === 'threw') {
        // Roots have no parent → seed `ancestorChainAllThrew=true`.
        const found = findDeepestUncaughtThrew(lastInGroup, 0, true);
        if (found && found.stmt.error) {
          return {
            statement: projectFailingStatement(found.stmt),
            error: found.stmt.error,
          };
        }
      }
      groupStart = groupEnd;
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
