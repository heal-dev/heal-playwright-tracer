/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// PRIMARY failure locator, used by `HealTracerReporter.onTestEnd`.
//
// Playwright already computes the source location of the UNCAUGHT
// failure and hands it to the reporter as `result.errors[].location`
// (`{ file, line, column }`). This finder maps that location straight
// onto the recorded statement at that line — no inference from the
// trace's `ok`/`threw` shape, no scope-name matching, no nesting
// assumptions. That makes it robust where the scope-shape heuristic is
// fragile:
//
//   - A source-level caught throw never appears in `result.errors`, so
//     it is structurally ignored (no "last in scope" reasoning needed).
//   - A test body nested inside a fixture's `await use(...)` is located
//     by its line regardless of how many `ok` wrappers sit above it.
//
// Falls back (returns null → caller runs `FailingStatementFinder`) when
// Playwright gives no usable location: worker crash, a timeout with no
// user stack frame, a thrown non-`Error` value, or a failure in a file
// the tracer did not instrument (no matching recorded statement).

import { basename } from 'path';

import type { Statement } from '../../domain/trace-event-recorder/model/statement-trace-schema';
import type { FoundFailure } from './failing-statement-finder';
import { parseStatementRoots, projectFailingStatement } from './parse-statement-roots';

/** The subset of Playwright's `Location` we consume. */
export interface ErrorLocation {
  file: string;
  line: number;
  column?: number;
}

/** Structural subset of Playwright's `TestError` (`result.errors[]`). */
export interface TestErrorLike {
  message?: string;
  stack?: string;
  location?: ErrorLocation;
}

export class LocationBasedFailureFinder {
  find(errors: readonly TestErrorLike[], ndjsonPath: string): FoundFailure | null {
    const located = errors.filter(hasLocation);
    if (located.length === 0) return null;

    const roots = parseStatementRoots(ndjsonPath);
    if (roots.length === 0) return null;

    // Errors are in Playwright's order; the first one we can map to a
    // recorded statement is the failure (soft-assert runs put the first
    // failure first too).
    for (const err of located) {
      const stmt = locateStatement(err.location, roots);
      if (!stmt) continue;
      return {
        statement: projectFailingStatement(stmt),
        // Prefer the statement's own recorded error (richer: causes,
        // isPlaywrightError, the in-trace stack). Synthesize from the
        // Playwright error only when the matched statement carries none.
        error: stmt.error ?? {
          message: err.message ?? 'Test failed',
          stack: err.stack,
          isPlaywrightError: true,
        },
      };
    }
    return null;
  }
}

function hasLocation(e: TestErrorLike): e is TestErrorLike & { location: ErrorLocation } {
  return !!e.location && typeof e.location.file === 'string' && typeof e.location.line === 'number';
}

// Find the recorded statement at `loc`. Walk the whole tree; keep the
// best statement whose file matches and whose [line, endLine] range
// contains the target line. Ties broken by (1) `threw` over `ok` — the
// throwing statement at that line is the failure, not a sibling — then
// (2) deepest, so a nested call on the same line wins over its caller.
function locateStatement(loc: ErrorLocation, roots: Statement[]): Statement | null {
  const targetFile = basename(loc.file);
  const matches: Match[] = [];

  const visit = (stmt: Statement, depth: number): void => {
    const inRange = loc.line >= stmt.line && loc.line <= (stmt.endLine ?? stmt.line);
    if (basename(stmt.file) === targetFile && inRange) matches.push({ stmt, depth });
    for (const child of stmt.children) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);

  if (matches.length === 0) return null;
  return matches.reduce((best, cur) => (isBetter(cur, best) ? cur : best)).stmt;
}

interface Match {
  stmt: Statement;
  depth: number;
}

function isBetter(cur: Match, best: Match): boolean {
  const curThrew = cur.stmt.status === 'threw';
  const bestThrew = best.stmt.status === 'threw';
  if (curThrew !== bestThrew) return curThrew; // a `threw` match beats an `ok` match
  return cur.depth > best.depth; // otherwise the deepest (most specific) wins
}
