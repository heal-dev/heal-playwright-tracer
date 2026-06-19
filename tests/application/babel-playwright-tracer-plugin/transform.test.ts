/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect } from 'vitest';
import { transform } from '../../helpers/transform';

// These tests run the plugin through @babel/core and assert on the
// generated source. Inline snapshots keep the expected output next to
// the intent so regressions fail loudly. If you intentionally change
// the instrumentation, re-run `vitest -u` to update the snapshots.

describe('transform', () => {
  it('skips files that do not match the include filter', () => {
    const out = transform(`foo();`, { filename: '/repo/src/app.ts' });
    expect(out).toContain('foo();');
    expect(out).not.toContain('__heal_enter');
  });

  it('wraps an expression statement in try/finally', () => {
    const out = transform(`foo();`);
    expect(out).toContain('globalThis.__heal_enter?.(');
    expect(out).toContain('try {');
    expect(out).toContain(`foo();`);
    expect(out).toContain('globalThis.__heal_throw?.(');
    expect(out).toContain('globalThis.__heal_ok?.(');
  });

  it('hoists const bindings and passes them to __heal_ok', () => {
    const out = transform(`const x = compute();`);
    // Hoist: `let x;` then assignment happens inside the try.
    expect(out).toMatch(/let x;/);
    expect(out).toMatch(/x = compute\(\);/);
    // __heal_ok is called with { x } so the runtime can snapshot its value.
    expect(out).toMatch(/__heal_ok\?\.\(\{\s*x\s*}\)/);
  });

  it('skips a var declaration that forms the head of a for-loop', () => {
    const out = transform(`for (let i = 0; i < 3; i++) {}`);
    // The for-head `let i = 0` must not get its own __heal_enter; otherwise
    // we'd rewrite the for head into a block.
    expect(out).toContain('for (let i = 0; i < 3; i++)');
  });

  it('skips CJS-generated require declarations (var X = require(Y))', () => {
    // This is what @babel/plugin-transform-modules-commonjs emits —
    // if we instrumented it we would call __heal_enter before the runtime
    // global is installed.
    const src = `var _foo = _interopRequireDefault(require("foo"));\nfoo();`;
    const out = transform(src);
    expect(out).toContain(`_interopRequireDefault(require("foo"))`);
    // The synthesized require declaration should not be wrapped.
    const firstEnterIdx = out.indexOf('__heal_enter');
    const requireIdx = out.indexOf('_interopRequireDefault');
    expect(requireIdx).toBeLessThan(firstEnterIdx);
  });

  it('rewrites @playwright/test import to @heal-dev/heal-playwright-tracer', () => {
    const out = transform(`import { test, expect } from '@playwright/test';\ntest('x', () => {});`);
    expect(out).toContain(`"@heal-dev/heal-playwright-tracer"`);
    expect(out).not.toContain(`"@playwright/test"`);
  });

  it('tags statements with hasAwait when an await is on the sync path', () => {
    const out = transform(`await foo();`);
    expect(out).toMatch(/hasAwait:\s*true/);
  });

  it('does not set hasAwait for awaits nested in a deeper arrow', () => {
    const out = transform(`foo(async () => { await bar(); });`);
    // The outer statement has no synchronous await, so hasAwait is false.
    expect(out).toMatch(/hasAwait:\s*false/);
  });

  it('derives scope names from test()/describe() titles', () => {
    const out = transform(`test('my case', async () => { foo(); });`);
    expect(out).toContain(`scope: "test: my case"`);
  });

  it('does not double-instrument (_traced marker prevents recursion)', () => {
    const out = transform(`foo();`);
    const enterMatches = out.match(/globalThis\.__heal_enter\?\./g) ?? [];
    expect(enterMatches).toHaveLength(1);
  });

  it('emits throw statements with the original error rethrown', () => {
    const out = transform(`foo();`);
    // catch(_e) should call __heal_throw(_e) then re-throw _e.
    expect(out).toMatch(/__heal_throw\?\.\(_traceErr\w*\)/);
    expect(out).toMatch(/throw _traceErr\w*;/);
  });

  it('skips empty files (no output changes beyond a pass)', () => {
    const out = transform(``);
    expect(out.trim()).toBe('');
  });

  it('skips function declarations as a whole (body is still visited)', () => {
    const out = transform(`function f() { foo(); }`);
    // The FunctionDeclaration itself is not wrapped; the inner
    // expression statement still gets instrumented.
    expect(out).toMatch(/function f\(\)\s*\{/);
    expect(out).toContain('__heal_enter');
  });

  it('attaches a line comment above a statement as leadingComment', () => {
    const out = transform(`// click the button\nfoo();`);
    expect(out).toContain(`leadingComment: "click the button"`);
  });

  it('attaches a block comment above a statement as leadingComment', () => {
    const out = transform(`/* click the button */\nfoo();`);
    expect(out).toContain(`leadingComment: "click the button"`);
  });

  it('joins stacked comments with \\n in source order', () => {
    const out = transform(`// first\n// second\nfoo();`);
    expect(out).toContain(String.raw`leadingComment: "first\nsecond"`);
  });

  it('omits leadingComment entirely when no comment precedes the statement', () => {
    const out = transform(`foo();`);
    expect(out).not.toContain('leadingComment');
  });

  it('documents Babel attachment: same-line trailing comment lands on the NEXT statement', () => {
    // `foo(); // inline\nbar();` — the inline comment is
    // separated from `bar()` only by a newline, so Babel attaches
    // it as bar's leading comment, not foo's trailing. The test
    // serves as living documentation: if Babel ever changes this
    // rule, we'll notice.
    const out = transform(`foo(); // inline\nbar();`);

    // Exactly one emitted leadingComment across the file.
    const matches = out.match(/leadingComment: "inline"/g) ?? [];
    expect(matches).toHaveLength(1);

    // Split on enter-call boundaries and identify the block that
    // wraps `bar()` — that's where leadingComment must live.
    const enterCalls = out.split('globalThis.__heal_enter?.').slice(1);
    const barEnter = enterCalls.find((chunk) => chunk.includes(`source: "bar();"`));
    const fooEnter = enterCalls.find((chunk) => chunk.includes(`source: "foo();"`));
    expect(barEnter).toBeDefined();
    expect(fooEnter).toBeDefined();
    expect(barEnter).toContain(`leadingComment: "inline"`);
    expect(fooEnter).not.toContain('leadingComment');
  });

  describe('pre-processor emit', () => {
    it('emits `await __heal_preprocess?.(...)` inside the try body for an async test leaf', () => {
      const out = transform(`test('x', async () => { await page.click("a"); });`);
      // The preprocess call must appear after `try {` and before the
      // user statement (`await page.click(...)`). The body of the
      // outer test() ExpressionStatement also gets wrapped, so we
      // narrow the assertion to the inner enter block whose source
      // is the click call.
      const blocks = out.split('globalThis.__heal_enter?.').slice(1);
      const innerBlock = blocks.find((b) => b.includes(`source: "await page.click(\\"a\\");"`));
      expect(innerBlock).toBeDefined();
      expect(innerBlock!).toContain('await globalThis.__heal_preprocess?.(');
      // Order: preprocess call must come BEFORE the original statement.
      const preprocessIdx = innerBlock!.indexOf('await globalThis.__heal_preprocess?.');
      const userStmtIdx = innerBlock!.indexOf('await page.click("a")');
      expect(preprocessIdx).toBeGreaterThan(0);
      expect(userStmtIdx).toBeGreaterThan(preprocessIdx);
    });

    it('does NOT emit the preprocess call for a leaf inside a sync function', () => {
      const out = transform(`function helper() { foo(); }`);
      // `foo();` is wrapped (its enclosing `helper()` is sync) — the
      // wrapper must not contain an `await` because that would be a
      // syntax error inside a sync function.
      expect(out).toContain('foo();');
      expect(out).not.toContain('__heal_preprocess');
    });

    it('emits the preprocess call inside the assignments path of a hoisted const', () => {
      // `const x = await compute();` inside an async fn — the
      // VariableDeclaration path hoists the binding and assigns
      // inside the try. The preprocess call must land BEFORE the
      // hoisted assignment.
      const out = transform(`test('x', async () => { const x = await compute(); });`);
      const blocks = out.split('globalThis.__heal_enter?.').slice(1);
      const declBlock = blocks.find((b) => b.includes(`kind: "variable"`));
      expect(declBlock).toBeDefined();
      const preprocessIdx = declBlock!.indexOf('await globalThis.__heal_preprocess?.');
      // Search for the assignment AFTER the preprocess emit — the
      // first occurrence of `x = await compute()` is inside the
      // `source: "..."` meta literal, not the hoisted assignment.
      const assignIdx = declBlock!.indexOf('x = await compute()', preprocessIdx + 1);
      expect(preprocessIdx).toBeGreaterThan(0);
      expect(assignIdx).toBeGreaterThan(preprocessIdx);
    });

    it('emits the SAME meta object shape for preprocess as for enter', () => {
      // The preprocess call must receive the full meta literal — same
      // fields the recorder gets via __heal_enter — so consumer
      // pre-processors can read file/startLine/source/etc.
      const out = transform(`test('x', async () => { foo(); });`);
      const blocks = out.split('globalThis.__heal_enter?.').slice(1);
      const inner = blocks.find((b) => b.includes(`source: "foo();"`))!;
      // Both calls must reference the same identifying fields.
      expect(inner).toMatch(/__heal_preprocess\?\.\(\{[^}]*file:[^}]*startLine:\s*1/);
      expect(inner).toMatch(/__heal_preprocess\?\.\(\{[^}]*source: "foo\(\);"/);
    });

    it('async arrow with concise body (no inner statement) — outer leaf still gets preprocess', () => {
      // The outer statement `test('x', async () => bar());` is itself
      // a leaf at module level (sync enclosing → no preprocess). The
      // inner `bar()` is in expression position, never visited as a
      // Statement. Expect zero preprocess emits.
      const out = transform(`test('x', async () => bar());`);
      expect(out).not.toContain('__heal_preprocess');
    });

    it('produces no double-instrumentation: exactly one preprocess per traced leaf', () => {
      const out = transform(`test('x', async () => { foo(); bar(); });`);
      const matches = out.match(/__heal_preprocess\?\.\(/g) ?? [];
      // Two leaf statements — `foo();` and `bar();` — each gets one
      // preprocess emit. The outer `test('x', ...)` statement is at
      // module level (sync enclosing), so it doesn't add a third.
      expect(matches).toHaveLength(2);
    });
  });

  describe('expect-screenshot injection', () => {
    it('inserts the helper line in front of `await expect(ident).toBeVisible()`', () => {
      const out = transform(`test('x', async () => { await expect(heading).toBeVisible(); });`);
      // The helper call appears verbatim (no `?.()` optional chain
      // because that lives at the production-time call site, not in
      // the source — it does in fact, see below).
      expect(out).toContain('await globalThis.__heal_expect_screenshot?.(heading)');
      // And the `__enter` block carrying the synthetic source must
      // be emitted before the assertion's `__enter` block. Two ways
      // to verify: (1) the helper's source string is present, (2) it
      // appears before the assertion's source string.
      const helperIdx = out.indexOf('source: "await __heal_expect_screenshot(heading)"');
      const assertionIdx = out.indexOf('source: "await expect(heading).toBeVisible();"');
      expect(helperIdx).toBeGreaterThan(-1);
      expect(assertionIdx).toBeGreaterThan(helperIdx);
    });

    it('hoists a non-Identifier target into an ignored const and retargets the assertion', () => {
      const out = transform(
        `test('x', async () => { await expect(page.getByRole('heading')).toBeVisible(); });`,
      );
      // A hoist `const _healExpectTarget…` carrying the
      // @heal-tracer-ignore comment.
      expect(out).toMatch(/@heal-tracer-ignore\s*\n\s*const _healExpectTarget/);
      // Helper screenshots the hoisted binding…
      expect(out).toMatch(/await globalThis\.__heal_expect_screenshot\?\.\(_healExpectTarget\w*\)/);
      // …and the assertion now references it too — the original
      // `page.getByRole(...)` is evaluated exactly once.
      expect(out).toMatch(/await expect\(_healExpectTarget\w*\)\.toBeVisible\(\)/);
    });

    it('preserves the assertion statement’s original `source` field when the arg is rewritten', () => {
      // The trace shouldn't suddenly show `expect(_healExpectTarget1)`
      // — the user wrote `expect(page.getByRole(...))` and that's what
      // the recorder must report. `extractSource` slices the file by
      // the assertion node's original `start`/`end`, which is what
      // makes this work.
      const out = transform(
        `test('x', async () => { await expect(page.getByRole('heading')).toBeVisible(); });`,
      );
      expect(out).toContain(`source: "await expect(page.getByRole('heading')).toBeVisible();"`);
    });

    it('matches `expect.soft(loc)…` and injects the same helper', () => {
      const out = transform(`test('x', async () => { await expect.soft(loc).toBeVisible(); });`);
      expect(out).toContain('await globalThis.__heal_expect_screenshot?.(loc)');
    });

    it('does NOT inject for `expect.poll(...)` — the first arg is a callback', () => {
      const out = transform(`test('x', async () => { await expect.poll(() => x).toBe(2); });`);
      expect(out).not.toContain('__heal_expect_screenshot');
    });

    it('does NOT inject for a sync expect (no top-level await)', () => {
      const out = transform(`test('x', async () => { expect(2).toBe(2); });`);
      expect(out).not.toContain('__heal_expect_screenshot');
    });

    it('does NOT inject inside a sync helper (no enclosing async)', () => {
      // The helper itself is `await __heal_expect_screenshot(...)`
      // — invalid in a non-async function. The detector is gated on
      // the same async-enclosing predicate as the preprocess emit.
      const out = transform(`function sync() { expect(loc).toBeVisible(); }`);
      expect(out).not.toContain('__heal_expect_screenshot');
    });

    it('emits `{ scroll: false }` for `toBeInViewport` so the assertion outcome is preserved', () => {
      const out = transform(`test('x', async () => { await expect(loc).toBeInViewport(); });`);
      expect(out).toMatch(
        /globalThis\.__heal_expect_screenshot\?\.\(loc,\s*\{\s*scroll:\s*false\s*\}\s*\)/,
      );
    });

    it('emits `{ scroll: false }` for `not.toBeInViewport` too', () => {
      const out = transform(`test('x', async () => { await expect(loc).not.toBeInViewport(); });`);
      expect(out).toMatch(
        /globalThis\.__heal_expect_screenshot\?\.\(loc,\s*\{\s*scroll:\s*false\s*\}\s*\)/,
      );
    });

    it('omits the options arg for regular matchers (defaults to scroll: true)', () => {
      const out = transform(`test('x', async () => { await expect(loc).toBeVisible(); });`);
      // No second arg — the call site is just `helper?.(loc)`.
      expect(out).toMatch(/globalThis\.__heal_expect_screenshot\?\.\(loc\)/);
    });

    describe('hideExpectScreenshots: true', () => {
      it('folds the helper into the assertion’s try-body (no separate enter block)', () => {
        const out = transform(`test('x', async () => { await expect(heading).toBeVisible(); });`, {
          pluginOptions: { hideExpectScreenshots: true },
        });
        // No synthetic `__heal_expect_screenshot` source field is
        // emitted — the helper isn't its own statement anymore.
        expect(out).not.toContain('source: "await __heal_expect_screenshot');
        // But the helper call IS present, inside the assertion's try.
        expect(out).toContain('await globalThis.__heal_expect_screenshot?.(heading)');
        // And the assertion runs immediately AFTER the helper call —
        // anchor on the helper-call substring and search beyond it for
        // the user statement to avoid matching the assertion's `source:
        // "await expect(heading)..."` meta-literal field earlier in
        // the output.
        const helperCall = 'await globalThis.__heal_expect_screenshot?.(heading)';
        const helperIdx = out.indexOf(helperCall);
        expect(helperIdx).toBeGreaterThan(-1);
        const userIdx = out.indexOf('await expect(heading).toBeVisible()', helperIdx);
        expect(userIdx).toBeGreaterThan(helperIdx);
      });

      it('still hoists non-Identifier targets so the locator factory runs once', () => {
        const out = transform(
          `test('x', async () => { await expect(page.getByRole('heading')).toBeVisible(); });`,
          { pluginOptions: { hideExpectScreenshots: true } },
        );
        expect(out).toMatch(/const _healExpectTarget/);
        expect(out).toMatch(
          /await globalThis\.__heal_expect_screenshot\?\.\(_healExpectTarget\w*\)/,
        );
        expect(out).toMatch(/await expect\(_healExpectTarget\w*\)\.toBeVisible\(\)/);
      });

      it('folds BOTH the pre- and after-snap helpers into the assertion try-body', () => {
        // Symmetry: with the flag on, the raw (after) snap is hidden the
        // same way the highlight (pre) snap is — neither becomes its own
        // step, both run inside the assertion's try body (pre before the
        // assertion, after as the last statement so it's success-only).
        const out = transform(`test('x', async () => { await expect(heading).toBeVisible(); });`, {
          pluginOptions: { hideExpectScreenshots: true },
        });
        expect(out).toContain('await globalThis.__heal_expect_screenshot?.(heading)');
        expect(out).toContain('await globalThis.__heal_expect_screenshot_after?.(heading)');
        // Neither helper gets its own enter event — no synthetic sources.
        expect(out).not.toContain('source: "await __heal_expect_screenshot');
        // Order inside the try body: pre-snap, then the user assertion,
        // then the after-snap.
        const preIdx = out.indexOf('await globalThis.__heal_expect_screenshot?.(heading)');
        const userIdx = out.indexOf('await expect(heading).toBeVisible()', preIdx);
        const afterIdx = out.indexOf('await globalThis.__heal_expect_screenshot_after?.(heading)');
        expect(preIdx).toBeLessThan(userIdx);
        expect(userIdx).toBeLessThan(afterIdx);
      });

      it('does not double-wrap the helper — exactly one __heal_enter for the assertion', () => {
        // In hidden mode the helper is `_traced=true`, so the
        // Statement visitor must NOT re-process it and emit its own
        // enter/ok block. The assertion remains a single leaf, so
        // exactly one `__heal_enter` is generated for it (the meta
        // literal is also reprinted inside `__heal_preprocess`,
        // hence the source string appears twice in the output —
        // anchor on `__heal_enter` specifically).
        const out = transform(`test('x', async () => { await expect(heading).toBeVisible(); });`, {
          pluginOptions: { hideExpectScreenshots: true },
        });
        // Count `__heal_enter` calls in the entire generated source.
        // Two are expected: one for the outer test('x', …)
        // ExpressionStatement, one for the assertion leaf. A
        // double-wrap of the helper would push this to 3.
        const enterMatches = out.match(/globalThis\.__heal_enter\?\./g) ?? [];
        expect(enterMatches).toHaveLength(2);
        // And no synthetic `__heal_expect_screenshot` source field
        // — the helper is part of the assertion's try-body, not its
        // own enter event.
        expect(out).not.toContain('source: "await __heal_expect_screenshot');
      });
    });

    it('emits three __heal_enter blocks for one visible-mode assertion (pre-snap, assertion, after-snap)', () => {
      // Visible mode default: BOTH screenshot helpers are their own
      // steps — one enter for the synthetic pre-snap line, one for the
      // user's assertion, one for the synthetic after-snap line. The
      // raw snap honours `hideExpectScreenshots` symmetrically with the
      // highlight, so in visible mode it is NOT folded onto the assertion.
      const out = transform(`test('x', async () => { await expect(heading).toBeVisible(); });`);
      // Outer test('x', …) enter + the three above = four.
      const enterMatches = out.match(/globalThis\.__heal_enter\?\./g) ?? [];
      expect(enterMatches).toHaveLength(4);
      // The three distinct enter-block sources.
      const preIdx = out.indexOf('source: "await __heal_expect_screenshot(heading)"');
      const assertIdx = out.indexOf('source: "await expect(heading).toBeVisible();"');
      const afterIdx = out.indexOf('source: "await __heal_expect_screenshot_after(heading)"');
      expect(preIdx).toBeGreaterThan(-1);
      expect(assertIdx).toBeGreaterThan(-1);
      expect(afterIdx).toBeGreaterThan(-1);
      // Execution order: pre-snap → assertion → after-snap.
      expect(preIdx).toBeLessThan(assertIdx);
      expect(assertIdx).toBeLessThan(afterIdx);
    });
  });
});
