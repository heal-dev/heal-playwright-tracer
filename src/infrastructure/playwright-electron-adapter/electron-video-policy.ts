/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Video policy for Electron windows — pure functions mirroring the rules
// Playwright applies to its own `use.video` (playwright/lib/index.js):
//
//   off               → never record
//   on                → record, keep
//   retain-on-failure → record, keep only when the outcome differs from
//                       the expected one (a `test.fail()` that fails is
//                       NOT kept, exactly like Playwright)
//   on-first-retry    → record and keep only on the first retry
//   retry-with-video  → Playwright's legacy alias of on-first-retry
//
// The project's `use.video` is a string or `{ mode, size }`; an absent
// or unknown value means `off`.

export type ElectronVideoMode = 'on' | 'retain-on-failure' | 'on-first-retry' | 'off';

export interface VideoSize {
  width: number;
  height: number;
}

interface VideoModeObject {
  mode?: unknown;
  size?: unknown;
}

const KNOWN_MODES: ReadonlySet<string> = new Set([
  'on',
  'retain-on-failure',
  'on-first-retry',
  'off',
]);

function rawMode(useVideo: unknown): unknown {
  if (typeof useVideo === 'string') return useVideo;
  if (typeof useVideo === 'object' && useVideo !== null) return (useVideo as VideoModeObject).mode;
  return undefined;
}

/** Playwright's `use.video`, whatever its shape, to one of the four modes. */
export function normalizeVideoMode(useVideo: unknown): ElectronVideoMode {
  const raw = rawMode(useVideo);
  if (raw === 'retry-with-video') return 'on-first-retry';
  return typeof raw === 'string' && KNOWN_MODES.has(raw) ? (raw as ElectronVideoMode) : 'off';
}

/** The `size` of an object-form `use.video`, if it is a complete one. */
export function videoSizeFrom(useVideo: unknown): VideoSize | undefined {
  if (typeof useVideo !== 'object' || useVideo === null) return undefined;
  const size = (useVideo as VideoModeObject).size as Partial<VideoSize> | undefined;
  if (!size || typeof size.width !== 'number' || typeof size.height !== 'number') return undefined;
  return { width: size.width, height: size.height };
}

/** Whether a launch in this attempt records at all. */
export function shouldRecord(mode: ElectronVideoMode, retry: number): boolean {
  if (mode === 'off') return false;
  if (mode === 'on-first-retry') return retry === 1;
  return true;
}

export interface KeepContext {
  /** `testInfo.status` at teardown — undefined counts as passed. */
  status: string | undefined;
  /** `testInfo.expectedStatus` — `failed` inside `test.fail()`. */
  expectedStatus: string;
  retry: number;
}

/** Whether a recording made under `mode` is kept once the test ended. */
export function shouldKeep(mode: ElectronVideoMode, ctx: KeepContext): boolean {
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  if (mode === 'on-first-retry') return ctx.retry === 1;
  return (ctx.status ?? 'passed') !== ctx.expectedStatus;
}
