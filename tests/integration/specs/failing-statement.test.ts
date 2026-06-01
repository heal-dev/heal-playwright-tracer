/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// End-to-end coverage for the reporter's failure-location pipeline:
// the PRIMARY `LocationBasedFailureFinder` (maps Playwright's
// `result.errors[].location` onto a recorded statement) and the
// FALLBACK `FailingStatementFinder` scope-grouping heuristic.
//
// The unit suites feed both finders hand-authored data, so they can
// only assert on shapes the real tracer + Playwright are *assumed* to
// produce. These tests prove the real Babel-instrumented tracer and the
// live reporter actually produce them, and that `execution.json` ends up
// with the REAL failure (not a swallowed probe, not an `ok` fixture
// wrapper) in `failingStatement` + `error`.
//
// Three scenarios in one Playwright run (amortizes install + worker
// startup): the source try/catch in the test body, the same in a
// `beforeEach` hook (cross-scope), and a test body nested inside a
// custom fixture's `await use(...)` (the location path's headline win —
// a body crash hidden under an `ok` use() wrapper, which the scope
// heuristic alone cannot see). All match the per-test titles in
// `failing-statement-spec.ts`.

import { beforeAll, describe, it, expect } from 'vitest';
import { IntegrationSandbox } from '../bootstrap/integration-sandbox';
import { DiskTraceReader } from '../bootstrap/test-doubles/disk-trace-reader';
import { DiskManifestReader } from '../bootstrap/test-doubles/disk-manifest-reader';
import { FAILING_STATEMENT_SPEC } from '../fixtures/failing-statement-spec';
import { findStatement, type ParsedTrace } from '../fixtures/parsed-trace';
import type { ExecutionTestEntry } from '../../../src/domain/persistence';

let traces: Map<string, ParsedTrace>;
let manifestByTitle: Map<string, ExecutionTestEntry>;

beforeAll(async () => {
  const tarballPath = process.env.INTEGRATION_TARBALL;
  if (!tarballPath) throw new Error('INTEGRATION_TARBALL not set — globalSetup failed?');

  const sandbox = new IntegrationSandbox({
    tarballPath,
    specSource: FAILING_STATEMENT_SPEC,
  });
  sandbox.scaffold();
  sandbox.install();
  // Exit code 1 is expected: both scenarios fail on a real uncaught
  // `expect`. `runPlaywright` already tolerates that.
  await sandbox.runPlaywright();

  traces = new DiskTraceReader().collect(sandbox.getRoot());
  if (traces.size === 0) {
    throw new Error('No traces collected from disk — did the sandbox spec run at all?');
  }
  manifestByTitle = new DiskManifestReader().readByTitle(sandbox.getRoot());
});

function getTrace(title: string): ParsedTrace {
  const trace = traces.get(title);
  if (!trace) {
    const available = [...traces.keys()].join(', ') || '(none)';
    throw new Error(`No trace found for "${title}". Available titles: ${available}`);
  }
  return trace;
}

function getEntry(title: string): ExecutionTestEntry {
  const entry = manifestByTitle.get(title);
  if (!entry) {
    const available = [...manifestByTitle.keys()].join(', ') || '(none)';
    throw new Error(`No manifest entry for "${title}". Available titles: ${available}`);
  }
  return entry;
}

describe('integration: FailingStatementFinder scope-grouping end-to-end', () => {
  it('records a source-level caught throw as a root `threw` followed by an `ok` (the finder assumption)', () => {
    // This is the load-bearing claim the whole scope-grouping design
    // rests on. If the real tracer ever stops emitting a caught throw
    // as a root `threw`, the unit tests still pass but production
    // regresses — this assertion is the only guard against that.
    const trace = getTrace('caught-throw-then-real-failure');

    const caughtProbe = findStatement(trace, (s) => s.source.includes('swallowed probe'));
    expect(caughtProbe, 'caught probe should be recorded as a root statement').toBeDefined();
    expect(caughtProbe!.status).toBe('threw');

    const recovered = findStatement(trace, (s) => s.source.includes('recovered'));
    expect(recovered, 'a following root proves execution continued').toBeDefined();
    expect(recovered!.status).toBe('ok');

    // The caught probe and the recovery root share the body scope and
    // appear before the real failure — exactly the [threw, ok, threw]
    // single-scope group the finder walks.
    const realFailure = findStatement(trace, (s) => s.source.includes('expected-value'));
    expect(realFailure).toBeDefined();
    expect(realFailure!.status).toBe('threw');
    expect(caughtProbe!.scope, 'caught probe and real failure are in the same scope').toBe(
      realFailure!.scope,
    );
  });

  it('body source try/catch: execution.json surfaces the real failure, not the caught probe', () => {
    const entry = getEntry('caught-throw-then-real-failure');
    expect(entry.attempts).toHaveLength(1);
    const attempt = entry.attempts[0];
    expect(attempt.status).toBe('failed');

    // The whole point: the finder skipped the swallowed probe and the
    // recovery root, and landed on the uncaught `expect`.
    expect(attempt.failingStatement).toBeDefined();
    expect(attempt.failingStatement!.source).toContain('expected-value');
    expect(attempt.failingStatement!.source).not.toContain('swallowed probe');

    expect(attempt.error).toBeDefined();
    expect(attempt.error!.message).not.toMatch(/swallowed probe/);
  });

  it('beforeEach source try/catch: finder falls through the non-crashing hook scope to the body failure', () => {
    const title = 'beforeEach-caught-throw-then-body-failure';

    // The hook's caught probe is recorded as a `threw` root in the
    // beforeEach scope, but that scope's LAST root is `ok` (the hook
    // recovery), so the scope did not crash and the finder must skip it.
    const trace = getTrace(title);
    const hookProbe = findStatement(trace, (s) => s.source.includes('swallowed hook probe'));
    expect(hookProbe, 'hook caught probe should be recorded').toBeDefined();
    expect(hookProbe!.status).toBe('threw');

    // The hook's probe lives in a different scope than the body failure
    // — otherwise there would be nothing cross-scope to fall through.
    const bodyFailure = findStatement(trace, (s) => s.source.includes('body-expected'));
    expect(bodyFailure).toBeDefined();
    expect(hookProbe!.scope).not.toBe(bodyFailure!.scope);

    // Sanity: the hook scope's last ROOT really is `ok` (not `threw`),
    // which is what makes it a non-crashing scope the finder skips.
    // Mirror the finder: it groups root statements only, never children.
    const hookScope = hookProbe!.scope;
    const hookRoots = trace.statements.filter((s) => s.scope === hookScope);
    expect(hookRoots.length).toBeGreaterThan(0);
    expect(hookRoots[hookRoots.length - 1].status).toBe('ok');

    const attempt = getEntry(title).attempts[0];
    expect(attempt.failingStatement).toBeDefined();
    expect(attempt.failingStatement!.source).toContain('body-expected');
    expect(attempt.failingStatement!.source).not.toContain('swallowed hook probe');
  });

  it('fixture use() wrapper: the body failure is a NESTED threw the scope heuristic alone cannot see', () => {
    // The shape the location path exists to handle: the real
    // Babel-instrumented tracer records a body that runs inside a
    // fixture's `await use(...)` as DESCENDANTS of that use() statement,
    // and use() itself resolves `ok` despite the body throwing. So the
    // crash is invisible to a root-only scan — only Playwright's
    // reported error location can pinpoint it. If this shape ever
    // changes, the unit tests still pass but production regresses; this
    // assertion is the guard against that.
    const title = 'fixture-use-wrapped-body-failure';
    const trace = getTrace(title);

    const realFailure = findStatement(trace, (s) => s.source.includes('wrapped-expected-value'));
    expect(realFailure, 'the uncaught expect should be recorded').toBeDefined();
    expect(realFailure!.status).toBe('threw');
    expect(realFailure!.scope, 'the failure lives in the test-body scope').toContain(title);

    // It must NOT be a root statement — it lives under the fixture
    // wrapper. (Roots are `trace.statements`; nested calls live in each
    // statement's `children`.)
    const isRoot = trace.statements.some((s) => s === realFailure);
    expect(isRoot, 'the body failure must be NESTED, not a root statement').toBe(false);

    // And every ROOT scope-group ends in `ok` (the use() wrappers and
    // their `ok` resolutions) — so the scope-grouping heuristic finds
    // nothing here and the location path is what locates the crash.
    let groupStart = 0;
    while (groupStart < trace.statements.length) {
      const scope = trace.statements[groupStart].scope;
      let groupEnd = groupStart + 1;
      while (groupEnd < trace.statements.length && trace.statements[groupEnd].scope === scope) {
        groupEnd++;
      }
      expect(
        trace.statements[groupEnd - 1].status,
        `root scope-group "${scope}" must end in ok (crash is hidden, not at root)`,
      ).toBe('ok');
      groupStart = groupEnd;
    }
  });

  it('fixture use() wrapper: execution.json surfaces the nested body failure (location path end-to-end)', () => {
    const title = 'fixture-use-wrapped-body-failure';
    const entry = getEntry(title);
    expect(entry.attempts).toHaveLength(1);
    const attempt = entry.attempts[0];
    expect(attempt.status).toBe('failed');

    // The fix: `LocationBasedFailureFinder` mapped Playwright's reported
    // error location straight onto the buried statement and wrote it.
    // Pre-fix this was `null` (the scope heuristic returned nothing),
    // which made heal-cli `analyze` throw `NoFailedAttemptError`.
    expect(attempt.failingStatement, 'location path must locate the hidden crash').toBeDefined();
    expect(attempt.failingStatement!.source).toContain('wrapped-expected-value');
    expect(attempt.failingStatement!.scope).toContain(title);
    expect(attempt.error).toBeDefined();
  });
});
