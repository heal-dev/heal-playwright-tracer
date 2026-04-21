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
});
