/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Feature: network capture — sidecar NDJSON stream of one record per
// HTTP exchange that fired during a test (browser-context traffic +
// runner-side `playwright.request` traffic).
//
// Public surface is the `NetworkCaptureSession` class. The fixture
// owns construction, attachment to BrowserContexts /
// APIRequestContexts, and the `stop(testFailed)` call at teardown.

export { NetworkCaptureSession } from './network-capture-session';
export type { NetworkCaptureDeps } from './network-capture-session';
export { NetworkCoalescer } from './network-coalescer';
export { redactHeaders, DEFAULT_REDACT_HEADERS } from './redaction';
export {
  isTextualContentType,
  previewBody,
  utf8SafeSlice,
  DEFAULT_TEXTUAL_CONTENT_TYPES,
} from './body-preview';
