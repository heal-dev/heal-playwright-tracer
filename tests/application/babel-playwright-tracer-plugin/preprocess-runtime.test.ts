/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Runtime integration: transforms a snippet of test source, installs a
// fake `globalThis.__heal_preprocess`, evaluates the transformed code,
// and asserts the preprocessor received the right meta objects in the
// right order — relative to the user statement and to other emitted
// hooks. This proves the full chain (Babel emit → globalThis lookup →
// invocation order) without requiring a real Playwright sandbox.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { transform } from '../../helpers/transform';

interface RecordedCall {
  hook: 'enter' | 'preprocess' | 'ok' | 'throw' | 'user';
  meta?: Record<string, unknown>;
  arg?: unknown;
}

const HOOKS = ['__heal_enter', '__heal_preprocess', '__heal_ok', '__heal_throw'] as const;

async function withGlobals<T>(
  installs: Record<string, unknown>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const g = globalThis as unknown as Record<string, unknown>;
  const previous: Record<string, unknown> = {};
  for (const k of Object.keys(installs)) {
    previous[k] = g[k];
    g[k] = installs[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(installs)) g[k] = previous[k];
  }
}

describe('preprocess runtime integration', () => {
  let calls: RecordedCall[];

  beforeEach(() => {
    calls = [];
  });

  afterEach(() => {
    // Defensive: clear the four hook globals between tests so a leak
    // from the previous test cannot contaminate the next one.
    const g = globalThis as unknown as Record<string, unknown>;
    for (const k of HOOKS) delete g[k];
  });

  // The caller passes statements that are MEANT to run inside an
  // async function (so the emitted `await __heal_preprocess?.(...)`
  // is syntactically legal). We wrap them in `async function $entry`
  // BEFORE the Babel transform so the visitor sees an async enclosing
  // function, then evaluate the transformed source and await
  // `$entry()` so any rejection propagates back to the test.
  async function runTransformed(asyncBody: string): Promise<void> {
    const wrapped = `async function $entry() { ${asyncBody} }`;
    const transformed = transform(wrapped);
    // `new Function(...)` is necessary here: the whole point of this
    // test is to eval Babel-transformed code under controlled globals
    // and observe the call sequence. Disabling the lint at the call
    // site, not at the file level, so the rule still catches actual
    // misuse elsewhere in this file.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(`${transformed}; return $entry();`) as () => Promise<void>;
    await fn();
  }

  it('preprocess fires once per leaf with the same meta the recorder gets', async () => {
    await withGlobals(
      {
        __heal_enter: (meta: Record<string, unknown>) => calls.push({ hook: 'enter', meta }),
        __heal_preprocess: async (meta: Record<string, unknown>) => {
          calls.push({ hook: 'preprocess', meta });
        },
        __heal_ok: () => calls.push({ hook: 'ok' }),
        __heal_throw: (e: unknown) => calls.push({ hook: 'throw', arg: e }),
        user: (label: string) => calls.push({ hook: 'user', arg: label }),
      },
      () => runTransformed(`globalThis.user('first'); globalThis.user('second');`),
    );

    // Expected order, per leaf statement, the Babel emit guarantees:
    //   enter → preprocess → user → ok
    // Two leaves → two of each pattern.
    const preprocessEvts = calls.filter((c) => c.hook === 'preprocess');
    expect(preprocessEvts).toHaveLength(2);

    // Both preprocess calls received metas with matching `source` and
    // `kind` fields populated by the meta-literal builder.
    expect(preprocessEvts[0].meta).toMatchObject({
      kind: 'expression',
      source: `globalThis.user('first');`,
    });
    expect(preprocessEvts[1].meta).toMatchObject({
      kind: 'expression',
      source: `globalThis.user('second');`,
    });

    // Ordering: for each leaf, preprocess must come AFTER the
    // matching enter and BEFORE the matching user-statement call.
    function indicesFor(source: string): { enter: number; preprocess: number; user: number } {
      const enter = calls.findIndex(
        (c) => c.hook === 'enter' && (c.meta as { source?: string }).source === source,
      );
      const preprocess = calls.findIndex(
        (c) => c.hook === 'preprocess' && (c.meta as { source?: string }).source === source,
      );
      const userLabel = source.match(/'([^']+)'/)?.[1];
      const user = calls.findIndex((c) => c.hook === 'user' && c.arg === userLabel);
      return { enter, preprocess, user };
    }
    const first = indicesFor(`globalThis.user('first');`);
    expect(first.preprocess).toBeGreaterThan(first.enter);
    expect(first.user).toBeGreaterThan(first.preprocess);
    const second = indicesFor(`globalThis.user('second');`);
    expect(second.preprocess).toBeGreaterThan(second.enter);
    expect(second.user).toBeGreaterThan(second.preprocess);
  });

  it('without an installed __heal_preprocess the optional call is a silent no-op', async () => {
    // Only enter/ok/throw installed — preprocess slot stays undefined.
    // The `await globalThis.__heal_preprocess?.(...)` emit must NOT
    // throw; it returns `undefined` and the user statement runs.
    await withGlobals(
      {
        __heal_enter: () => calls.push({ hook: 'enter' }),
        __heal_ok: () => calls.push({ hook: 'ok' }),
        __heal_throw: (e: unknown) => calls.push({ hook: 'throw', arg: e }),
        user: () => calls.push({ hook: 'user' }),
      },
      () => runTransformed(`globalThis.user();`),
    );

    // No preprocess records (slot was undefined). The user call still ran.
    expect(calls.find((c) => c.hook === 'preprocess')).toBeUndefined();
    expect(calls.find((c) => c.hook === 'user')).toBeDefined();
  });

  it('preprocess composes multiple async hooks awaited in declaration order', async () => {
    // Simulates what playwright-fixture installs: a single
    // `__heal_preprocess` that loops over the registered preprocessors
    // and awaits each. Ordering must be deterministic.
    const seenOrder: string[] = [];
    const pp1 = async () => {
      await Promise.resolve();
      seenOrder.push('pp1');
    };
    const pp2 = async () => {
      await Promise.resolve();
      seenOrder.push('pp2');
    };
    const pp3 = async () => {
      seenOrder.push('pp3');
    };
    const installed = async () => {
      for (const pp of [pp1, pp2, pp3]) await pp();
    };

    await withGlobals(
      {
        __heal_enter: () => {},
        __heal_preprocess: installed,
        __heal_ok: () => {},
        __heal_throw: () => {},
        user: () => {},
      },
      () => runTransformed(`globalThis.user();`),
    );

    expect(seenOrder).toEqual(['pp1', 'pp2', 'pp3']);
  });

  it('a preprocessor that throws causes __heal_throw to fire for the statement', async () => {
    // The preprocess emit lives inside the same try/catch that wraps
    // the user statement. A throwing preprocessor must therefore
    // surface as a statement-level error, not as an uncaught
    // exception, and __heal_throw must be called.
    const innerError = new Error('preprocess failed');
    let caught: unknown;
    await withGlobals(
      {
        __heal_enter: () => calls.push({ hook: 'enter' }),
        __heal_preprocess: () => {
          throw innerError;
        },
        __heal_ok: () => calls.push({ hook: 'ok' }),
        __heal_throw: (e: unknown) => calls.push({ hook: 'throw', arg: e }),
        user: () => calls.push({ hook: 'user' }),
      },
      async () => {
        try {
          await runTransformed(`globalThis.user();`);
        } catch (e) {
          caught = e;
        }
      },
    );

    // The user statement never ran (preprocess threw before it).
    expect(calls.find((c) => c.hook === 'user')).toBeUndefined();
    // __heal_throw was called with the preprocessor's error.
    const throwEvt = calls.find((c) => c.hook === 'throw');
    expect(throwEvt).toBeDefined();
    expect(throwEvt!.arg).toBe(innerError);
    // The error propagated out of the wrapper to the eval site —
    // proving the trace hook does NOT swallow preprocessor failures.
    expect(caught).toBe(innerError);
  });
});
