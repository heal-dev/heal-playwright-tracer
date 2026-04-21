/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */

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
