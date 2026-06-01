/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// The Playwright spec driven by `failing-statement.test.ts`.
//
// Both tests reproduce the source-level `try { await x(); } catch {}`
// pattern that `FailingStatementFinder`'s scope-grouping was built for
// (see `failing-statement-finder.ts` header + commit "Switch to
// scope-grouping for root-level try/catch detection"). The finder is
// only exercised end-to-end here: the unit suite feeds it hand-authored
// NDJSON, so it asserts on a SHAPE the real tracer is *assumed* to
// emit. These tests prove the real Babel-instrumented tracer actually
// produces that shape — a caught throw recorded as a root `status:
// "threw"` with a following `ok` root in the same scope — and that the
// reporter then writes the REAL failure (not the swallowed probe) into
// `execution.json`.
//
// Browser-free on purpose (no `page` import): the scope-grouping logic
// reads only statement `status` + `scope`, never the DOM, so a browser
// would add ~10s per run for no extra signal. Same trade-off as
// `reporter-rescue-spec`.
//
// Both tests fail on purpose (a real uncaught `expect`), so the
// Playwright run exits 1 — `runPlaywright` tolerates that — and the
// attempt is non-passing, which is what makes the reporter run the
// finder at all.

export const FAILING_STATEMENT_SPEC = `import { test as base, expect } from '@playwright/test';

// Extend with a fixture whose \`use()\` wraps the test body (the
// fixture-use-wrapped-body-failure scenario). Assigned to \`test\` so the
// scope labeler tags the body \`test: <title>\` — the near-universal
// \`const test = base.extend(...)\` convention, and exactly how the
// heal-stories suite that surfaced this bug is written. The first two
// scenarios don't request \`wrappedValue\`, so the fixture stays lazy for
// them.
const test = base.extend<{ wrappedValue: string }>({
  wrappedValue: async ({}, use) => {
    await use('wrapped');
  },
});

test('caught-throw-then-real-failure', async () => {
  // Source-level try/catch swallows a throw. The tracer records the
  // awaited statement as status=threw (the rejection fires before JS
  // routes to the catch), then execution continues to the next root in
  // the same (body) scope. The finder must NOT mistake this for the
  // real failure.
  try {
    await Promise.reject(new Error('swallowed probe'));
  } catch {}
  // A normal root proves execution continued past the caught throw —
  // this following \`ok\` in the same scope is the only on-trace signal
  // that the throw above was caught at source.
  const recovered = true;
  void recovered;
  // The REAL, uncaught failure. The finder must surface THIS one.
  expect('actual-value').toBe('expected-value');
});

test.describe('hook-scope', () => {
  // The source try/catch lives in the hook this time. Exercises
  // cross-scope grouping: the beforeEach scope does not crash (its last
  // root is \`ok\`), so the finder falls through to the body scope,
  // whose last root threw for real.
  test.beforeEach(async () => {
    try {
      await Promise.reject(new Error('swallowed hook probe'));
    } catch {}
    const hookRecovered = true;
    void hookRecovered;
  });

  test('beforeEach-caught-throw-then-body-failure', async () => {
    expect('body-actual').toBe('body-expected');
  });
});

// Fixture \`use()\` wrapper scenario. The test body runs INSIDE the
// \`wrappedValue\` fixture's \`await use(...)\`, so the tracer records the
// whole body as DESCENDANTS of that use() statement. Playwright catches
// the body's uncaught \`expect\` at the fixture boundary, so
// \`await use(...)\` resolves \`ok\` and NO root scope-group ends in
// \`threw\`. The primary (root-only) scan therefore finds nothing — the
// finder's nested fallback must descend through the \`ok\` wrapper into
// the body's \`test:\` scope to surface the real failure. Reproduces the
// heal-stories \`admins can delete secrets\` shape (auth fixture).
test('fixture-use-wrapped-body-failure', async ({ wrappedValue }) => {
  void wrappedValue;
  expect('actual-value').toBe('wrapped-expected-value');
});
`;
