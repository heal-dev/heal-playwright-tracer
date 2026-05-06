/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Race a promise against a timer. On timeout, reject with a labeled
// Error so the caller can decide whether to swallow or surface.
//
// The original promise keeps running after the timeout — we cannot
// cancel arbitrary work, only stop awaiting it. Acceptable for
// best-effort decoration ops where a wedged page or hung user hook
// must not block the test.
//
// `clearTimeout` runs in `finally` so a fast-path resolve does not
// leak a Node timer handle into the event loop.

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `[heal-playwright-tracer] timeout: ${label} did not settle within ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
