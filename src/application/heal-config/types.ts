/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import type { TestInfo } from '@playwright/test';
import type { HealTraceExporter } from '../../domain/trace-event-recorder/port/heal-trace-exporter';

/**
 * Everything the fixture hands to a exporter or lifecycle factory when a
 * test starts. The `transport` subobject matches the envelope sidecar
 * adapters (e.g. `CollectorHttpExporter`) expect.
 */
export interface HealTracerTestContext {
  testInfo: TestInfo;
  /**
   * Absolute path to the per-test `heal-data` directory. Created by
   * the fixture before any factory runs.
   */
  healDataDir: string;
  transport: {
    runId: string;
    attempt: number;
    /** Absolute `testInfo.outputDir` — the pod-side collector reads files from here. */
    rootDir: string;
    /** Optional external execution id from `HEAL_EXECUTION_ID`. Omitted when unset. */
    executionId?: string;
  };
}

/**
 * Called once per test. Returns the exporter for that test; the fixture
 * closes it at teardown via `HealTraceExporter.close()`.
 */
export type HealTraceExporterFactory = (ctx: HealTracerTestContext) => HealTraceExporter;

/**
 * Per-test setup/teardown pair. Use this to install per-test globals,
 * open telemetry sessions, patch prototypes you'll unpatch later, etc.
 *
 * `setup` receives the `HealTracerTestContext` for the current test.
 * `teardown` takes no arguments — close over any state you need via
 * the enclosing factory or class fields.
 *
 * Errors in `setup` mark that lifecycle as uninstalled — its
 * `teardown` will NOT run. Errors in `teardown` are logged and
 * swallowed so they cannot mask a real test failure.
 */
export interface HealTestLifecycle {
  setup(ctx: HealTracerTestContext): void | Promise<void>;
  teardown(): void | Promise<void>;
}

/**
 * Factory for a `HealTestLifecycle`. Called once per test, before
 * `setup`. Always a factory — not a singleton object — so closure
 * state declared inside the factory is isolated between tests.
 *
 * The factory takes no arguments; the `HealTracerTestContext` arrives
 * via `setup(ctx)` instead. One-place-for-ctx keeps the signature
 * minimal and avoids the "which ctx do I use?" confusion that a
 * two-injection design would create.
 */
export type HealTestLifecycleFactory = () => HealTestLifecycle;

/**
 * Shape of the object passed to `configureTracer(...)`. Both fields
 * are optional — an empty config yields the default behaviour
 * (NDJSON-only output, no lifecycles).
 */
export interface HealTracerConfig {
  exporters?: HealTraceExporterFactory[];
  lifecycles?: HealTestLifecycleFactory[];
}
