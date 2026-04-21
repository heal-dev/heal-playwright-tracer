/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */

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
