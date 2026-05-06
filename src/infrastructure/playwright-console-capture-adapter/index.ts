/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Feature: console capture — sidecar NDJSON stream of every browser
// `console.*` and `pageerror` event fired during a test.
//
// Public API:
//   startConsoleCapture(initialContext, ndjsonPath, deps, config)
//     Builds a `ConsoleCaptureSession`, wires the initial
//     BrowserContext, and returns the session so the caller can wire
//     additional contexts later (popups created via
//     `browser.newContext()` in the test body) and call
//     `close()` at teardown.

export { ConsoleCaptureSession } from './console-capture-session';
export type { ConsoleCaptureDeps } from './console-capture-session';
