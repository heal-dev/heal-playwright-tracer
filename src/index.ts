/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */

export { test, expect, reset } from './application/playwright-fixture';

// Extension API. Users call `configureTracer(...)` from their
// `playwright.config.ts` to plug in exporters and bindings, and can
// register per-test teardown callbacks at runtime via
// `onTestTeardown(...)`.
export { configureTracer, onTestTeardown } from './application/heal-config';
export type {
  HealTracerConfig,
  HealTracerTestContext,
  HealTraceExporterFactory,
  HealTestLifecycle,
  HealTestLifecycleFactory,
} from './application/heal-config';

// Re-export the HealTraceExporter port and the record type it consumes,
// so consumers implementing their own exporter against
// `configureTracer({ exporters: [...] })` get both from the main entry
// without needing a subpath import. Deeper schema types (Statement,
// TestHeader, …) remain available via the
// `@heal-dev/heal-playwright-tracer/statement-trace-schema` subpath.
export type { HealTraceExporter } from './domain/trace-event-recorder/port/heal-trace-exporter';
export type { HealTraceRecord } from './domain/trace-event-recorder/model/statement-trace-schema';

// Re-export every symbol from @playwright/test so code that imports
// e.g. `devices`, `chromium`, or the `Page`/`Locator` types from our
// package still gets them. The named exports above take precedence
// in module-load order.
export * from '@playwright/test';
