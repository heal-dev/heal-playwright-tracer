/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Names of the global functions the Babel plugin injects into
// instrumented source and the recorder entrypoint installs on
// `globalThis`. Both sides import from here so the contract lives in
// one place.
//
// The names are deliberately prefixed with `__heal_` so anyone
// reading the Babel-transformed test source understands at a glance
// which library these hooks belong to. Rename them together (plugin
// and recorder entrypoint) if the package is ever renamed.

export const HEAL_ENTER = '__heal_enter';
export const HEAL_OK = '__heal_ok';
export const HEAL_THROW = '__heal_throw';

// User-extensible per-statement async hook. The Babel plugin emits
// `await globalThis.__heal_preprocess?.(meta)` inside the try body
// before the user's statement when the enclosing function is async.
// The fixture installs the global at test start by composing every
// `preProcessor` registered through `configureTracer({...})`. Stays
// `undefined` when no preprocessors are configured, so the optional
// call short-circuits to a no-op.
export const HEAL_PREPROCESS = '__heal_preprocess';

// Locator-screenshot helper invoked from Babel-injected lines placed
// in front of every `await expect(...)` / `await expect.soft(...)`
// the plugin sees. The fixture installs the global at test start; it
// runs the same `captureWithHighlight` pipeline locator actions use
// when the target duck-types as a Locator, and is a no-op otherwise.
// Stays `undefined` outside any test, so the optional call in the
// instrumented source short-circuits.
export const HEAL_EXPECT_SCREENSHOT = '__heal_expect_screenshot';

// After-capture sibling of `HEAL_EXPECT_SCREENSHOT`. The Babel plugin
// emits `await globalThis.__heal_expect_screenshot_after?.(target)` as
// the last statement in the assertion's try body — so it runs only
// when the matcher PASSED — to snap a second, overlay-free screenshot
// of the now-settled page into the `raw/` subfolder. No-op outside any
// test, like the others.
export const HEAL_EXPECT_SCREENSHOT_AFTER = '__heal_expect_screenshot_after';
