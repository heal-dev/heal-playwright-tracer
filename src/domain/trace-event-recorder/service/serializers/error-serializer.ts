/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
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
//     `.cause` with defensive String() fallbacks. This includes
//     Playwright's `TestInfoError` shape (`{ message, stack?,
//     value?, location? }`) which the fixture's pending-root flush
//     pulls from `testInfo.errors[0]` — those have no `name` and
//     constructor `Object`, so we apply a Playwright-signal upgrade
//     below to recover a useful class name.
//   - Primitives (strings, numbers, null, undefined): wraps them in
//     `{ message: String(thrown) }`.
//
// Every serialized error also carries `isPlaywrightError: boolean`,
// which the autopilot agent uses to distinguish Playwright-raised
// failures (timeouts, locator errors) from user-raised assertions.
// Detection is by constructor name OR by stack frame path OR by a
// known Playwright message pattern (timeout text).
//
// Strings (`message`, `stack`, and per-cause variants) are
// ANSI-stripped at the boundary because Playwright pre-colorizes
// some of its error text with terminal escape codes — those are
// noise for downstream consumers (DB rows, BFF JSON, frontend).

import type { SerializedError } from '../../model/serialized-error';

export type { SerializedError };

const PLAYWRIGHT_ERROR_CTOR = /^(TimeoutError|PlaywrightError|LocatorError|PlaywrightTestError)$/;
const PLAYWRIGHT_STACK = /(node_modules\/playwright|node_modules\/@playwright)/;
const PLAYWRIGHT_TIMEOUT_MSG = /^Test timeout of \d+ms exceeded/;
// CSI sequence: ESC [ … letter. Covers the SGR color codes
// Playwright uses (`\x1b[31m`, `\x1b[39m`) and any other Select
// Graphic Rendition the runtime might emit.
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, '');
}

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
  const stackStr = e.stack
    ? stripAnsi(String(e.stack).split('\n').slice(0, 20).join('\n'))
    : undefined;
  const message = stripAnsi(e.message != null ? String(e.message) : String(err));

  let name = e.name || ctorName || 'Error';
  const isPwStack = PLAYWRIGHT_STACK.test(stackStr || '');
  const looksLikeTimeout = PLAYWRIGHT_TIMEOUT_MSG.test(message);
  // Playwright's `testInfo.errors[i]` is a `TestInfoError`-shaped
  // plain object with no `.name` and constructor `Object`. When we
  // can prove the throw came from Playwright (stack path or
  // timeout message), upgrade the class name so consumers get a
  // useful discriminator instead of `Object` / `Error`.
  if ((name === 'Object' || name === 'Error') && (isPwStack || looksLikeTimeout)) {
    name = looksLikeTimeout ? 'TimeoutError' : 'PlaywrightError';
  }

  const result: SerializedError = { name, message };
  if (stackStr) result.stack = stackStr;

  result.isPlaywrightError = PLAYWRIGHT_ERROR_CTOR.test(ctorName) || isPwStack || looksLikeTimeout;

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
        message: stripAnsi(c.message != null ? String(c.message) : String(cur)),
        stack: c.stack ? stripAnsi(String(c.stack).split('\n').slice(0, 10).join('\n')) : undefined,
      });
      cur = c.cause;
    } else {
      causes.push({ message: stripAnsi(String(cur)) });
      break;
    }
    d++;
  }
  if (causes.length) result.causes = causes;
  return result;
}
