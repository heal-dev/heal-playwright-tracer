/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Locates the statement responsible for a test failure inside one
// `heal-traces.ndjson`, used by `HealTracerReporter.onTestEnd`.
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
// Nested fallback: when the test body runs inside a fixture's
// `await use(...)`, the tracer records the whole body as DESCENDANTS of
// that `use()` statement — and `use()` itself resolves `ok`, because
// Playwright catches the body's throw at the fixture/runtime boundary
// (not in user source). So no ROOT scope-group ends in `threw` and the
// primary scan returns null even though the test failed. When that
// happens, descend through the `ok` wrappers (in encounter order) and
// look for a nested runtime-lifecycle scope (`test:` / `beforeEach:` /
// …) whose last statement `threw` — that is the hidden crash. The scan
// is gated to lifecycle scopes so a regular helper whose internal
// try/catch swallowed a throw (its caller returned `ok`) is not
// resurfaced; only the test/hook boundary qualifies. Safe because the
// finder runs only on attempts that actually failed.
//
// Limitation: a test scope ending in a source-level `try{}catch{}`
// with no following code can't be distinguished from a real crash on
// trace alone. Long-term fix is AST-tagging statements lexically
// inside try/catch at trace ingest. Rare in practice.
//
// Limitation (nested fallback): the body scope must be labeled with a
// runtime-lifecycle name (`test:` / `beforeEach:` / …). That holds for
// the standard `const test = base.extend(...)` convention (the call-site
// identifier is `test`), but a fixture-extended test invoked under a
// differently-named binding (e.g. `authedTest(...)`) is labeled
// `<anonymous>`, indistinguishable from a helper scope — so a body crash
// hidden under such a wrapper falls back to null rather than risk
// resurfacing a caught helper throw.

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

// Runtime-entered scopes: the test callback and the lifecycle hooks.
// A throw that escapes one of these (last statement in the scope, no
// following sibling) is a real failure even when a wrapping ancestor
// returned `ok` — the only thing that "caught" it is the Playwright
// runtime at the fixture boundary. Mirrors the test-API names in
// `enclosing-scope-labeler.ts`; `describe`/`step` are excluded because
// user code can wrap them in try/catch. Matches `test: <title>` and
// the title-less `test()` form.
const RUNTIME_LIFECYCLE_SCOPE = /^(test|it|beforeEach|afterEach|beforeAll|afterAll)(:|\()/;

export class FailingStatementFinder {
  find(ndjsonPath: string): FoundFailure | null {
    let body: string;
    try {
      body = fs.readFileSync(ndjsonPath, 'utf8');
    } catch {
      return null;
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

    // Primary: walk consecutive same-scope root groups. First group
    // whose last root is `threw` is the crashing scope.
    const primary = scanScopeGroups(roots, false);
    if (primary) return primary;

    // Fallback: the test failed but no root scope-group crashed — the
    // crash is hidden under one or more `ok` fixture `await use(...)`
    // wrappers (see header). Descend through them to the nested
    // test/hook scope and locate its crash there.
    return findNestedLifecycleFailure(roots);
  }
}

// Walk `statements` as consecutive same-scope groups. For the first
// group whose LAST statement is `threw`, drill to the deepest uncaught
// throw and return it. When `lifecycleOnly` is set, only runtime-entered
// scopes (`test:` / `beforeEach:` / …) qualify — used by the nested
// fallback so a helper's internally-caught throw is never resurfaced.
function scanScopeGroups(statements: Statement[], lifecycleOnly: boolean): FoundFailure | null {
  let groupStart = 0;
  while (groupStart < statements.length) {
    const groupScope = statements[groupStart].scope;
    let groupEnd = groupStart + 1;
    while (groupEnd < statements.length && statements[groupEnd].scope === groupScope) {
      groupEnd++;
    }
    const lastInGroup = statements[groupEnd - 1];
    if (
      lastInGroup.status === 'threw' &&
      (!lifecycleOnly || RUNTIME_LIFECYCLE_SCOPE.test(groupScope))
    ) {
      // Seed `ancestorChainAllThrew=true`: this group's last statement is
      // itself the top of the uncaught chain at this level.
      const found = findDeepestUncaughtThrew(lastInGroup, 0, true);
      if (found && found.stmt.error) {
        return { statement: project(found.stmt), error: found.stmt.error };
      }
    }
    groupStart = groupEnd;
  }
  return null;
}

// Descend through `ok` wrappers (encounter order) looking for a nested
// runtime-lifecycle scope-group whose last statement `threw`. An `ok`
// statement whose subtree threw caught that throw at its own boundary
// (fixture `use()` / runtime); a `threw` statement's subtree was instead
// caught at THIS level, so we skip descending into it.
function findNestedLifecycleFailure(statements: Statement[]): FoundFailure | null {
  const here = scanScopeGroups(statements, true);
  if (here) return here;
  for (const s of statements) {
    if (s.status === 'threw') continue;
    const found = findNestedLifecycleFailure(s.children);
    if (found) return found;
  }
  return null;
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
