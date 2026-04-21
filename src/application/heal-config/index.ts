/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 *
 */

// Public surface of the tracer's extension API.
//
// Re-exports what a user (or a companion package like
// `@heal-dev/heal-playwright-tracer-sidecar`) needs to extend the
// tracer from their own `playwright.config.ts`.

export { configureTracer, getTracerConfig, onTestTeardown } from './registry';

// Internal-facing exports — consumed by the fixture only. Kept in the
// barrel because the fixture imports from this same file; external
// callers have no reason to touch them.
export { resetTeardownHooks, drainTeardownHooks } from './registry';

export type {
  HealTracerConfig,
  HealTracerTestContext,
  HealTraceExporterFactory,
  HealTestLifecycle,
  HealTestLifecycleFactory,
} from './types';
