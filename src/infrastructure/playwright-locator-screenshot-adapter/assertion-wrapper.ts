/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import type { Locator, Page } from 'playwright';
import { removeOverlay } from './overlay-helpers';
import { getActiveCaptureSession } from './locator-patch';

// Duck-type: a Playwright Locator always has both `.boundingBox` and
// `.page` as functions. FrameLocator / ElementHandle / Page won't match.
// We don't use `instanceof` because the Locator class is created lazily
// inside Playwright and isn't reliably exported for runtime checks.
function isLocator(target: unknown): target is Locator {
  if (!target || typeof target !== 'object') return false;
  const obj = target as Record<string, unknown>;
  return typeof obj.boundingBox === 'function' && typeof obj.page === 'function';
}

// Assertion methods in Playwright all start with `to` (toBeVisible,
// toHaveText, …). Every other property we see on the assertion
// instance — `not`, symbol keys, internal fields — we leave alone.
function isAssertionMethodName(prop: string | symbol): prop is string {
  return typeof prop === 'string' && prop.startsWith('to');
}

function wrapAssertion<T extends object>(assertion: T, locator: Locator): T {
  return new Proxy(assertion, {
    get(target, prop, _receiver) {
      // Read against `target` (not the proxy) so getters like `.not`
      // see the original `this` and don't recurse through the proxy.
      const value = Reflect.get(target, prop, target);

      if (prop === 'not' && value && typeof value === 'object') {
        return wrapAssertion(value, locator);
      }

      if (isAssertionMethodName(prop) && typeof value === 'function') {
        return async function patchedAssertion(...args: unknown[]) {
          const page =
            typeof (locator as { page?: () => Page }).page === 'function'
              ? (locator as { page: () => Page }).page()
              : null;
          let drawnNodeId: string | null = null;
          const session = getActiveCaptureSession();
          if (page && session) {
            try {
              drawnNodeId = await session.captureWithHighlight(page, locator, `assert-${prop}`);
            } catch (_) {
              // Capture is best-effort: never block the assertion.
            }
          }
          try {
            return await (value as (...a: unknown[]) => unknown).apply(target, args);
          } finally {
            if (drawnNodeId && page) {
              try {
                await removeOverlay(page, drawnNodeId);
              } catch (_) {
                // Page gone — nothing to clean.
              }
            }
          }
        };
      }

      return value;
    },
  });
}

// Build a callable wrapping `origFn(target, ...)`-shaped functions —
// used for both `expect` and `expect.soft`.
function wrapExpectCallable<F extends (...args: unknown[]) => unknown>(origFn: F): F {
  const wrapped = function wrappedExpect(this: unknown, target: unknown, ...rest: unknown[]) {
    const assertion = (origFn as (...a: unknown[]) => unknown).call(this, target, ...rest);
    if (isLocator(target) && assertion && typeof assertion === 'object') {
      return wrapAssertion(assertion, target);
    }
    return assertion;
  } as unknown as F;
  return wrapped;
}

export function wrapExpect<E extends (...args: unknown[]) => unknown>(origExpect: E): E {
  const wrapped = wrapExpectCallable(origExpect);

  // Copy static properties across so `wrapped.soft`, `wrapped.poll`,
  // `wrapped.configure`, `wrapped.extend`, etc. remain callable. `soft`
  // shares the `(target, ...)` contract so we wrap it the same way the
  // top-level expect is wrapped; everything else is forwarded as-is.
  for (const key of Reflect.ownKeys(origExpect)) {
    if (key === 'length' || key === 'name' || key === 'prototype') continue;
    const descriptor = Object.getOwnPropertyDescriptor(origExpect, key);
    if (!descriptor) continue;

    if (
      key === 'soft' &&
      'value' in descriptor &&
      typeof (descriptor as { value?: unknown }).value === 'function'
    ) {
      const softFn = (descriptor as { value: (...a: unknown[]) => unknown }).value;
      (descriptor as { value: unknown }).value = wrapExpectCallable(softFn);
    }

    try {
      Object.defineProperty(wrapped, key, descriptor);
    } catch (_) {
      // Some descriptors may be non-configurable on the target; skip
      // them — the caller can still reach them via the original expect.
    }
  }

  return wrapped;
}
