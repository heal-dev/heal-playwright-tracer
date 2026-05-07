/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Unified diagnostic logger for the tracer.
//
// Two levels — `error` and `warn` — both written to stderr with a
// consistent prefix so users can grep one or the other:
//
//   [heal-playwright-tracer] [error] <message>
//   [heal-playwright-tracer] [warn] <message>
//
// `error` is always loud — it surfaces failures that were
// previously console.error'd unconditionally (lifecycle setup
// rejections, projector.finalize timeouts, reporter file-write
// failures, …). The user needs to see these regardless of debug
// flags.
//
// `warn` is opt-in via `HEAL_DEBUG=1`. It surfaces best-effort
// failures the tracer recovers from silently in normal operation
// (CDP path falling back to the JS overlay, scroll throws,
// boundingBox null, overlay-cleanup catches). Without the env var
// these are noise; with it, they're a diagnostic for "why did the
// tracer behave this way on this page."
//
// `process.env.HEAL_DEBUG` is read at log time (not at module
// load) so tests can toggle it inside a single process without
// importing from a fresh module instance.

const PREFIX = '[heal-playwright-tracer]';

function isDebugEnabled(): boolean {
  return process.env.HEAL_DEBUG === '1';
}

function format(err: unknown): string {
  if (err === undefined) return '';
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  return `\n${detail}`;
}

export const log = {
  /**
   * Real failure the user should see by default. Always written to
   * stderr.
   */
  error(msg: string, err?: unknown): void {
    console.error(`${PREFIX} [error] ${msg}${format(err)}`);
  },
  /**
   * Best-effort failure that the tracer recovered from. Only
   * written to stderr when `HEAL_DEBUG=1`.
   */
  warn(msg: string, err?: unknown): void {
    if (isDebugEnabled()) {
      console.error(`${PREFIX} [warn] ${msg}${format(err)}`);
    }
  },
};
