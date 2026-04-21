/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */

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
