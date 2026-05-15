/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect } from 'vitest';
import { transform } from '../../helpers/transform';

// `// @heal-tracer-ignore` opt-out, exercised through the full Babel
// transform. We count `globalThis.__heal_enter?.(` occurrences: each
// wrapped leaf statement emits exactly one, so the count is a direct
// measure of "how many statements were instrumented".

function enterCount(out: string): number {
  return (out.match(/globalThis\.__heal_enter\?\./g) ?? []).length;
}

describe('// @heal-tracer-ignore directive', () => {
  it('skips only the annotated statement, not its siblings', () => {
    const out = transform(`// @heal-tracer-ignore\nfoo();\nbar();`);
    expect(out).toContain('foo();');
    expect(out).toContain('bar();');
    // Only bar() is wrapped.
    expect(enterCount(out)).toBe(1);
  });

  it('skips an entire arrow-function subtree (the route-handler case)', () => {
    const out = transform(
      `test('x', async () => {\n` +
        `  context.route(pred,\n` +
        `    // @heal-tracer-ignore\n` +
        `    async route => {\n` +
        `      await route.continue({ a: 1 });\n` +
        `    });\n` +
        `  await sentinel();\n` +
        `});`,
    );
    expect(out).toContain('route.continue({');
    // test(...) call, context.route(...) call, and sentinel() — but
    // NOT the await inside the ignored handler.
    expect(enterCount(out)).toBe(3);
  });

  it('skips an entire function-declaration subtree', () => {
    const out = transform(
      `// @heal-tracer-ignore\nasync function helper() {\n  await deep();\n}\nhelper();`,
    );
    // Only the helper() call site is wrapped; the body is silenced.
    expect(enterCount(out)).toBe(1);
    expect(out).toContain('await deep();');
  });

  it('skips a compound-statement subtree', () => {
    const out = transform(`// @heal-tracer-ignore\nif (cond) {\n  doX();\n}\nafter();`);
    // Only after() is wrapped; doX() inside the ignored if is not.
    expect(enterCount(out)).toBe(1);
  });

  it('accepts the block-comment form', () => {
    const out = transform(`/* @heal-tracer-ignore */\nfoo();\nbar();`);
    expect(enterCount(out)).toBe(1);
  });

  it('does not match on a word-boundary lookalike', () => {
    const out = transform(`// @heal-tracer-ignored-elsewhere\nfoo();`);
    // `@heal-tracer-ignored` is not the directive — foo() is still traced.
    expect(enterCount(out)).toBe(1);
    expect(out).toContain('globalThis.__heal_enter?.(');
  });
});
