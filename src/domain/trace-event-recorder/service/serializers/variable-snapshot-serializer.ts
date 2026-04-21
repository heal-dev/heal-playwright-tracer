/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 *
 */

// Turns a `{ name: value }` map of user variables into a trace-safe
// snapshot that the ok-event-builder attaches to the `meta.vars`
// field. Called from `__ok` with the bindings the Babel
// instrumenter passed to it (only for `VariableDeclaration`
// statements — `const x = compute()` sends `{ x }`).
//
// "Trace-safe" means:
//
//   - **Size-capped**. Strings are truncated at 200 chars, arrays
//     keep the first 10 elements, objects keep the first 10 keys.
//     The trace buffer has to serialize to JSON at teardown and get
//     attached to a Playwright report; shipping a 50 MB mega-object
//     would break both.
//   - **Depth-capped**. Walks stop at depth 2 and replace deeper
//     values with a `[Ctor]` placeholder.
//   - **Plain-object only**. Only object literals (`{}` / `Object.create(null)`)
//     and arrays are walked. Any class instance — Playwright's `Page`, an SDK
//     adapter holding an API key, a `Date`, a `URL`, the user's domain
//     types — short-circuits to a `[Ctor]` placeholder. This is the
//     default-safe rule: walking a class instance can dump private state
//     (e.g. `apiKey`, auth headers) into the trace, which then ships to the
//     report. Plain JSON-shaped data — `await response.json()`, config
//     objects, user records — is what tests actually inspect, and that path
//     is preserved.
//   - **Throwing-getter tolerant**. A property whose getter throws
//     becomes the string `[getter threw]` instead of crashing the
//     whole ok event.

export function safeValue(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return v;
  const type = typeof v;
  if (type === 'number' || type === 'boolean') return v;
  if (type === 'string') {
    const s = v as string;
    return s.length > 200 ? s.slice(0, 197) + '…' : s;
  }
  if (type === 'function') return `[Function ${(v as { name?: string }).name || 'anonymous'}]`;
  if (type === 'symbol' || type === 'bigint') return String(v);
  if (type !== 'object') return String(v);

  if (v instanceof Error) {
    return { __error: true, name: v.name, message: v.message };
  }

  const obj = v as Record<string, unknown>;
  const ctor = (obj.constructor && (obj.constructor as { name?: string }).name) || '';
  // Anything that isn't a plain object literal or array becomes opaque.
  // Object.create(null) instances have no constructor and are treated as plain.
  const isPlainObject = ctor === '' || ctor === 'Object';
  if (!isPlainObject && !Array.isArray(v)) {
    return `[${ctor}]`;
  }
  if (depth >= 2) return `[${ctor || 'Object'}]`;

  if (Array.isArray(v)) {
    const out: unknown[] = v.slice(0, 10).map((x) => safeValue(x, depth + 1));
    if (v.length > 10) out.push(`…${v.length - 10} more`);
    return out;
  }
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const k of Object.keys(obj)) {
    if (count >= 10) {
      out['…'] = `${Object.keys(obj).length - 10} more keys`;
      break;
    }
    try {
      out[k] = safeValue(obj[k], depth + 1);
    } catch (_) {
      out[k] = '[getter threw]';
    }
    count++;
  }
  return out;
}

export function safeVars(vars: unknown): Record<string, unknown> | undefined {
  if (!vars || typeof vars !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(vars as Record<string, unknown>)) {
    try {
      out[k] = safeValue((vars as Record<string, unknown>)[k], 0);
    } catch (_) {
      out[k] = '[serialize threw]';
    }
  }
  return out;
}
