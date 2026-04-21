/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 *
 */

// Prototype-patches `Locator.prototype` so every user-facing action
// becomes: draw magenta overlay → screenshot → original action →
// remove overlay. The capture pipeline itself lives in
// ./capture-highlight.ts; this file only owns the list of actions
// to patch, the idempotent prototype rewrite, and the registry that
// tells the patched methods which capture session is active.
//
// Why the registry: `Locator.prototype` is process-global and patched
// exactly once, so the patched method bodies are lexically fixed.
// Looking up `getActiveCaptureSession()` from inside the patch lets
// the fixture swap per-test sessions without re-patching the prototype.
//
// After the screenshot is written to disk, the filename is stamped
// directly onto the enter event currently on top of the recorder's
// active-enter stack via the session's `onScreenshotWritten` callback.
// That's how a statement like `await button.click()` ends up with
// its highlight screenshot visible at the statement level in the
// final trace.
//
// The patch runs once per process and is idempotent via a Symbol
// marker on the Locator prototype.

import type { Page } from 'playwright';
import type { ScreenshotCaptureSession } from './screenshot-capture-session';
import { removeOverlay } from './overlay-helpers';

// Locator action methods that will be highlighted and screenshotted.
// User-facing actions only — not queries, not waits, not assertions.
// If Playwright adds new action methods, append them here.
export const HIGHLIGHTED_LOCATOR_ACTIONS = [
  'click',
  'dblclick',
  'tap',
  'fill',
  'clear',
  'hover',
  'press',
  'pressSequentially',
  'type',
  'check',
  'uncheck',
  'setChecked',
  'focus',
  'blur',
  'selectOption',
  'selectText',
  'setInputFiles',
  'dragTo',
  'scrollIntoViewIfNeeded',
];

const PATCHED = Symbol.for('heal-playwright-tracer.locator-patched');

interface PatchableProto {
  [PATCHED]?: boolean;
  [key: string]: unknown;
}

// Active-session registry. The fixture sets this at test start and
// clears it at teardown; the patched methods read it on every call.
let activeSession: ScreenshotCaptureSession | null = null;

export function setActiveCaptureSession(session: ScreenshotCaptureSession | null): void {
  activeSession = session;
}

export function getActiveCaptureSession(): ScreenshotCaptureSession | null {
  return activeSession;
}

// Idempotent proto patch. Call once per process with any Page-like
// object that produces a Locator via `locator('body')` — we grab the
// prototype from it and overwrite every action method.
export function ensureLocatorPrototypePatched(samplePage: Page): void {
  const proto = Object.getPrototypeOf(samplePage.locator('body')) as PatchableProto;
  if (!proto || proto[PATCHED]) return;
  proto[PATCHED] = true;

  for (const name of HIGHLIGHTED_LOCATOR_ACTIONS) {
    const orig = proto[name];
    if (typeof orig !== 'function') continue;
    proto[name] = async function patched(this: unknown, ...args: unknown[]) {
      const self = this as {
        page?: () => Page;
        boundingBox?: () => Promise<{
          x: number;
          y: number;
          width: number;
          height: number;
        } | null>;
      };
      const pg = typeof self.page === 'function' ? self.page() : null;
      const session = activeSession;
      const drawnNodeId = pg && session ? await session.captureWithHighlight(pg, self, name) : null;

      try {
        return await (orig as (...a: unknown[]) => Promise<unknown>).apply(self, args);
      } finally {
        if (drawnNodeId && pg) {
          try {
            await removeOverlay(pg, drawnNodeId);
          } catch (_) {
            // Page closed / navigated / element detached — nothing to clean.
          }
        }
      }
    };
  }
}
