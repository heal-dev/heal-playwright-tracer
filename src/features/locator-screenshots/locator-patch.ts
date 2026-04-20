// Prototype-patches `Locator.prototype` so every user-facing action
// becomes: draw magenta overlay → screenshot → original action →
// remove overlay. The capture pipeline itself lives in ./capture.ts;
// this file only owns the list of actions to patch and the idempotent
// prototype rewrite that routes each one through the pipeline.
//
// After the screenshot is written to disk, the filename is stamped
// directly onto the enter event currently on top of the recorder's
// active-enter stack via `setCurrentStatementScreenshot` (inside the
// capture helper). That's how a statement like `await button.click()`
// ends up with its highlight screenshot visible at the statement
// level in the final trace.
//
// The patch runs once per process and is idempotent via a Symbol
// marker.

import type { Page } from 'playwright';
import { captureWithHighlight, removeOverlay } from './capture-highlight';

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
      const drawnNodeId = pg ? await captureWithHighlight(pg, self, name) : null;

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
