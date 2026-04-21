/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 *
 */

// Normalizes a thrown value into the `meta.error` shape that the
// throw-event-builder attaches to every throw event.
//
// The tracer must handle every possible thrown shape without
// crashing — JS lets you `throw anything`, so this function copes
// with:
//
//   - Real `Error` instances (the common case): extracts `name`,
//     `message`, truncated stack, and walks the `.cause` chain up
//     to 5 levels deep.
//   - Non-Error objects: reads `.name` / `.message` / `.stack` /
//     `.cause` with defensive String() fallbacks.
//   - Primitives (strings, numbers, null, undefined): wraps them in
//     `{ message: String(thrown) }`.
//
// Every serialized error also carries `isPlaywrightError: boolean`,
// which the autopilot agent uses to distinguish Playwright-raised
// failures (timeouts, locator errors) from user-raised assertions.
// Detection is by constructor name OR by stack frame path —
// Playwright errors either have a recognizable class name or their
// stack includes `node_modules/@playwright`.

import type { SerializedError } from '../../model/serialized-error';

export type { SerializedError };

const PLAYWRIGHT_ERROR_CTOR = /^(TimeoutError|PlaywrightError|LocatorError|PlaywrightTestError)$/;
const PLAYWRIGHT_STACK = /(node_modules\/playwright|node_modules\/@playwright)/;

export function serializeError(err: unknown): SerializedError {
  if (err == null) return { message: String(err) };
  if (typeof err !== 'object') return { message: String(err) };

  const e = err as {
    constructor?: { name?: string };
    name?: string;
    message?: unknown;
    stack?: unknown;
    cause?: unknown;
  };
  const ctorName = (e.constructor && e.constructor.name) || '';
  const stackStr = e.stack ? String(e.stack).split('\n').slice(0, 20).join('\n') : undefined;

  const result: SerializedError = {
    name: e.name || ctorName || 'Error',
    message: e.message != null ? String(e.message) : String(err),
  };
  if (stackStr) result.stack = stackStr;

  result.isPlaywrightError =
    PLAYWRIGHT_ERROR_CTOR.test(ctorName) || PLAYWRIGHT_STACK.test(stackStr || '');

  const causes: SerializedError['causes'] = [];
  let cur: unknown = e.cause;
  let d = 0;
  while (cur != null && d < 5) {
    if (typeof cur === 'object') {
      const c = cur as {
        name?: string;
        constructor?: { name?: string };
        message?: unknown;
        stack?: unknown;
        cause?: unknown;
      };
      causes.push({
        name: c.name || (c.constructor && c.constructor.name) || 'Error',
        message: c.message != null ? String(c.message) : String(cur),
        stack: c.stack ? String(c.stack).split('\n').slice(0, 10).join('\n') : undefined,
      });
      cur = c.cause;
    } else {
      causes.push({ message: String(cur) });
      break;
    }
    d++;
  }
  if (causes.length) result.causes = causes;
  return result;
}
