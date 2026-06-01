/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Public types for the tracer's extension API.
//
// A user of `@heal-dev/heal-playwright-tracer` extends the tracer by
// calling `configureTracer(config)` from their `playwright.config.ts`
// with a `HealTracerConfig`. The config lists:
//
//   - `exporters`      — additional `HealTraceExporter` factories. Each factory
//                    is called once per test with a fresh
//                    `HealTracerTestContext`. Returned exporters are
//                    composed into a tee alongside the default NDJSON
//                    exporter.
//   - `lifecycles` — per-test setup/teardown pairs. Each entry is a
//                    `HealTestLifecycleFactory` called once per test;
//                    the returned `HealTestLifecycle` exposes
//                    `setup(ctx)` (runs at test start) and `teardown()`
//                    (runs in `finally`, in reverse order, before the
//                    trace is finalized). Factories — not singleton
//                    objects — because per-test instantiation keeps
//                    any closure state isolated between tests.
//   - `preProcessors` — per-statement async hooks. Each entry is a
//                    `StatementPreProcessor` function awaited before
//                    every traced leaf statement (in async contexts).
//                    Use this to run side effects that must complete
//                    before Playwright resolves the next locator —
//                    e.g. DOM stamping, selector resolution, paint
//                    of overlays. Plain functions, no factory.
//
// The design is deliberately narrow: a few arrays, no plugin
// discovery, no magic globals. Anything fancier is the user's
// `playwright.config.ts` to write.

import type { BrowserContext, Request as PwRequest, TestInfo } from '@playwright/test';
import type { HealTraceExporter } from '../../domain/trace-event-recorder/port/heal-trace-exporter';
import type { ConsoleLevel } from '../../domain/trace-event-recorder/model/console-trace-schema';
import type { EnterMeta } from '../../domain/trace-event-recorder/model/enter-meta';

/**
 * Everything the fixture hands to a exporter or lifecycle factory
 * when a test starts. The `transport` subobject carries the per-test
 * correlation identifiers any outbound exporter needs.
 */
export interface HealTracerTestContext {
  testInfo: TestInfo;
  /**
   * Absolute path to the per-(test, attempt) directory under the
   * persistent history root — `<cwd>/heal-traces/<executionId>/<testId>/<attempt>/`.
   * Created by the fixture before any factory runs. The ndjson, the
   * per-statement screenshots, and any reporter-copied Playwright
   * artefacts (trace.zip, video, failure screenshots) all land
   * inside this directory.
   */
  healDataDir: string;
  transport: {
    /**
     * Playwright's `testInfo.testId` — stable hash of
     * (file, title, project). Shared across attempts of the same
     * test, unique per distinct test. Together with `attempt` it
     * forms the per-test-attempt correlation key.
     */
    testId: string;
    attempt: number;
    /**
     * Per-process executionId resolved at fixture time
     * (HEAL_EXECUTION_ID, else uuidv4).
     */
    executionId: string;
    /**
     * Absolute path to the per-(test, attempt) directory under the
     * persistent heal-traces tree — same as `healDataDir`. Kept on
     * `transport` so exporters that ship artefacts out-of-band have
     * a stable name for the directory they should consult.
     */
    rootDir: string;
    /**
     * Absolute path to the per-test `heal-traces.ndjson` file the
     * default NDJSON exporter writes to. Sourced from
     * `HealTracesLayout` so it reflects the real on-disk location.
     * Exporters that ship artifacts out-of-band can use this as the
     * authoritative location of the per-test trace file.
     */
    healTracesFilePath: string;
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
 * Context passed to a `StatementPreProcessor` on every call. Extends
 * `HealTracerTestContext` with the live `browserContext` for the
 * current test so a pre-processor can read pages, evaluate scripts,
 * stamp DOM, etc. before the user's statement runs.
 *
 * `browserContext` is the same object Playwright passes to the test —
 * pre-processors share it with the test body, so any mutation the
 * pre-processor makes is visible to the statement that follows.
 */
export interface StatementPreProcessorContext extends HealTracerTestContext {
  browserContext: BrowserContext;
}

/**
 * Async function called once per traced leaf statement, before the
 * statement body runs. The Babel plugin emits
 * `await globalThis.__heal_preprocess?.(meta)` inside the try block;
 * the fixture installs a single global that loops over every
 * registered pre-processor in declaration order and awaits each.
 *
 * Async-context only: the emit is gated on the enclosing function
 * being `async`. Statements inside synchronous helpers skip the
 * pre-processor chain entirely (we cannot `await` from a sync
 * function).
 *
 * Errors thrown by a pre-processor are caught by the statement's own
 * try/catch — they will be reported as a `__heal_throw` for the
 * statement, NOT swallowed silently. Pre-processors should therefore
 * be defensive about their own internal failures (try/catch, log,
 * return) when a partial side-effect is acceptable.
 *
 * Plain function — no class, no factory, no setup/teardown. Bind a
 * method if you need instance state; or close over module-scoped
 * state in `playwright.config.ts`.
 */
export type StatementPreProcessor = (input: {
  meta: EnterMeta;
  ctx: StatementPreProcessorContext;
}) => void | Promise<void>;

/**
 * Caps applied to async work the tracer wraps around the user's
 * test. Both fields are optional; the fixture falls back to sensible
 * defaults when omitted. The point of these caps is that the tracer
 * must never outlast the work it is decorating — a hung overlay
 * cleanup or a wedged user exporter must surface and unblock the
 * test rather than hang it.
 */
export interface HealTracerTimeouts {
  /**
   * Cap on every async the screenshot pipeline awaits — locator
   * resolution (`boundingBox`, `locator.evaluate`), overlay draw /
   * remove (`page.evaluate`), every CDP send (`Overlay.*`,
   * `Page.captureScreenshot`, `Runtime.*`), `newCDPSession`, and
   * the `page.screenshot` fallback. Capture is best-effort: on
   * timeout the screenshot is dropped and the action proceeds.
   * Default: 10_000ms.
   */
  screenshotMs?: number;
  /**
   * Cap on user-extensible per-test work — each lifecycle `setup` /
   * `teardown`, the drained `onTestTeardown` hook chain, and the
   * final `projector.finalize` (which closes every registered
   * exporter). On timeout the fixture logs to stderr and continues
   * with the next teardown step. Default: 30_000ms.
   */
  lifecycleMs?: number;
}

/**
 * When and how the network adapter inlines request/response bodies.
 *   - `'never'` (default): bodies are never read; only `bytes` is
 *     populated when known via `Content-Length`. Cheapest option.
 *   - `'always'`: textual bodies under `maxBodyBytes` are inlined as
 *     `requestBody.preview` / `responseBody.preview` on every record.
 *   - `'on-error'`: bodies are buffered in memory while the test
 *     runs and flushed as separate `network-body` records ONLY if
 *     the test ends in a failing status. Discarded otherwise. Useful
 *     for keeping the happy-path light while still getting payloads
 *     for failing runs.
 */
export type HealTracerNetworkBodyMode = 'never' | 'always' | 'on-error';

/**
 * Tunables for `heal-network.ndjson` capture. Capture is on by
 * default; pass `enabled: false` to suppress the stream. Tests and
 * exceptional setups use this; the public configuration docs treat
 * network capture as always-on.
 */
export interface HealTracerNetworkConfig {
  /** Pass `false` to suppress the stream. Defaults to `true`. */
  enabled?: boolean;
  /** See `HealTracerNetworkBodyMode`. Defaults to `'never'`. */
  bodyMode?: HealTracerNetworkBodyMode;
  /**
   * Per-body cap in bytes. Bodies larger than this are not buffered;
   * the record records `bytes` and sets `truncated: true`. Default:
   * 8192.
   */
  maxBodyBytes?: number;
  /**
   * Headers (case-insensitive) the adapter MUST strip from both
   * request and response headers before writing. Merged with a
   * baked-in default denylist (`authorization`, `cookie`,
   * `set-cookie`, `proxy-authorization`, `x-api-key`, `x-auth-token`)
   * — provide additional names here to extend, not replace, that
   * list.
   */
  redactHeaders?: string[];
  /**
   * Predicate to drop requests entirely before they reach the
   * coalescer. Return `false` to skip a request (e.g. ignore noisy
   * telemetry endpoints). Errors thrown by this function are
   * swallowed and the request is kept.
   */
  urlFilter?: (url: string, request: PwRequest) => boolean;
  /**
   * Content-type allowlist for body inlining. A response whose
   * `Content-Type` does not match any of these regexes will record
   * `bytes` only, no `preview`. Defaults cover textual payloads
   * (`text/*`, `application/json`, `application/xml`,
   * `application/x-www-form-urlencoded`, `application/javascript`).
   */
  contentTypeAllowlist?: RegExp[];
}

/**
 * Tunables for `heal-console.ndjson` capture. On by default; pass
 * `enabled: false` to suppress the stream. Same opt-out story as
 * `HealTracerNetworkConfig`.
 */
export interface HealTracerConsoleConfig {
  /** Pass `false` to suppress the stream. Defaults to `true`. */
  enabled?: boolean;
  /**
   * Levels to keep. Anything else is dropped before being written.
   * Default keeps everything (`['log','info','warn','error','debug','trace','pageerror']`).
   */
  levels?: ConsoleLevel[];
  /**
   * Per-arg cap in bytes — the JSON-serialized form of any single
   * `console.*` argument is truncated past this. Default: 4096.
   */
  maxArgBytes?: number;
  /**
   * Cap on the number of args kept per console event. Default: 10.
   */
  maxArgsPerEvent?: number;
}

/**
 * Tunables for the test's source-file manifest capture. OFF by
 * default — copying user source into the trace artifact is a
 * deliberate opt-in (size + privacy). Pass `enabled: true` to capture
 * the spec file plus its transitive import graph (user files only;
 * `node_modules` and out-of-root files are always excluded).
 *
 * Captured files land on disk under the per-test `sources/` directory
 * and are referenced by a `test-source` manifest record in
 * `heal-traces.ndjson`. See `TestSourceRecord` in
 * `statement-trace-schema.ts` for the wire format.
 */
export interface HealTracerSourceConfig {
  /** Pass `true` to enable the capture. Defaults to `false`. */
  enabled?: boolean;
  /**
   * Hard cap on the number of files captured (graph traversal stops
   * once this many distinct files have been resolved). Default: 200.
   */
  maxFiles?: number;
  /**
   * Per-file size cap in bytes. Files larger than this are not copied
   * to disk; the manifest still records them with `truncated: true`
   * and `bytes` set so inventory remains complete. Default: 524288
   * (512 KB).
   */
  maxFileBytes?: number;
}

/**
 * Shape of the object passed to `configureTracer(...)`. All fields
 * are optional — an empty config yields the default behaviour
 * (statement-stream NDJSON + network and console sidecars, no
 * lifecycles, default timeouts).
 */
export interface HealTracerConfig {
  exporters?: HealTraceExporterFactory[];
  lifecycles?: HealTestLifecycleFactory[];
  /**
   * Per-statement async hooks. Each function in this array is awaited
   * before the user's statement runs (gated on the enclosing function
   * being `async`). Useful for pre-execution side-effects that must
   * complete before Playwright resolves a locator — e.g. stamping the
   * DOM with attributes a custom selector strategy depends on.
   */
  preProcessors?: StatementPreProcessor[];
  timeouts?: HealTracerTimeouts;
  network?: HealTracerNetworkConfig;
  console?: HealTracerConsoleConfig;
  source?: HealTracerSourceConfig;
}
