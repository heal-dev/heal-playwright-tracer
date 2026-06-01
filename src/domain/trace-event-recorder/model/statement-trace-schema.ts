/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Output schema for `heal-traces.ndjson` — the agent-facing wire
// format written one record per line.
//
// The file is a stream, not a single document: each line is exactly
// one `HealTraceRecord`. Per test the records appear in this order:
//
//   1. Exactly one `test-header` record (first line). Carries static
//      per-test metadata and environment fields; the fields known
//      only at test-end (status, duration, stdout, stderr) live on
//      `test-result` instead.
//   2. Zero or more `statement` records, each a ROOT statement
//      (directly inside the test body). Nested calls live inline
//      inside `statement.children` and never appear as standalone
//      records. Consumers must not expect a flat stream of every
//      executed statement.
//   3. Optionally, a `test-source` record listing the test's
//      transitive source-file manifest. Written by the fixture only
//      when `configureTracer({ source: { enabled: true } })` opts in.
//      Absent otherwise; absence is not an error.
//   4. Exactly one `test-result` record. If it is missing, the test
//      crashed mid-run and the trace should be treated as partial.
//      A `test-attachments` record may be appended AFTER `test-result`
//      by the optional reporter — see `TestAttachmentsRecord`.
//
// The projector in `../../trace-event-recorder/projectors/
// statement-projector.ts` is what produces these records from the
// raw recorder event stream (enter/ok/throw/meta). Consumers (the
// Heal autopilot agent, humans debugging a failing test) should
// import these types to stay in sync with the file format.

export const HEAL_TRACE_SCHEMA_VERSION = 3;

/**
 * One line of a `heal-traces.ndjson` file. Discriminated by `kind`.
 */
export type HealTraceRecord =
  | TestHeaderRecord
  | StatementRecord
  | TestResultRecord
  | TestAttachmentsRecord
  | TestSourceRecord;

export interface TestHeaderRecord {
  kind: 'test-header';
  schemaVersion: typeof HEAL_TRACE_SCHEMA_VERSION;
  test: TestHeader;
}

export interface TestHeader {
  title: string;
  titlePath: string[];
  file: string;
  project: string;
  workerIndex: number;
  retry: number;
  /** Wall-clock ms (Date.now()) at which the recorder was reset for this test. */
  startedAt: number;
  env: TestEnv;
  context: TestContext;
}

/**
 * Per-test correlation identifiers. Populated by the fixture from
 * Playwright's `TestInfo`. The global correlation key for a test
 * attempt is `(testId, attempt)` — two attempts of the same test
 * share `testId` and differ in `attempt`.
 */
export interface TestContext {
  /**
   * Playwright's `testInfo.testId` — a stable hash of
   * (file, title, project). Distinct tests always get distinct
   * values; two attempts of the same test share this value. Also
   * serves as the cross-worker correlation key: a retry landing in
   * a different worker still reports the same `testId`.
   */
  testId: string;
  /**
   * 1-indexed attempt number. Equal to `testInfo.retry + 1` — the
   * first run of a test is attempt 1, the first retry is attempt 2,
   * and so on.
   */
  attempt: number;
  /**
   * Heal test case id sourced from the `@heal-<id>` Playwright tag
   * on the test (e.g. `test('…', { tag: '@heal-42' }, …)`). The
   * suffix after `@heal-` is parsed as a positive integer — it must
   * match the `bigint` primary key on `backend.test_cases`. When
   * present, the backend resolver links every trace event for this
   * run to the referenced test case (after verifying the id belongs
   * to the API key's org). When absent, events go to the unlinked
   * bucket.
   *
   * Tags over annotations because they are CLI-filterable — the
   * backend triggers a specific set of test cases with
   * `npx playwright test -g "@heal-42|@heal-57"`, no file paths or
   * line numbers required.
   */
  testCaseId?: number;
  /**
   * Per-process execution id. Sourced from `HEAL_EXECUTION_ID` when
   * set (so multi-shard CI shares one id), else a per-process
   * `randomUUID()`. Used to scope on-disk artefacts under
   * `<rootDir>/heal-traces/<executionId>/...` and to group
   * historical runs in the local viewer. Optional for backwards
   * compatibility with traces produced before this field existed.
   */
  executionId?: string;
}

export interface TestEnv {
  nodeVersion?: string;
  platform?: string;
  arch?: string;
  hostname?: string;
  isCI?: boolean;
  cwd?: string;
  gitSha?: string;
  pid?: number;
}

export interface StatementRecord {
  kind: 'statement';
  /**
   * Always a ROOT statement (its runtime parentSeq was null). The
   * full subtree is nested in `statement.children`; nested calls
   * never appear as separate records in the stream.
   */
  statement: Statement;
}

export interface Statement {
  /** Execution-order sequence number, identical to the raw enter event's seq. */
  seq: number;

  /**
   * 0-based, contiguous, per-test execution-order index. Increments
   * by 1 every time a new statement is entered (roots and nested
   * children alike), so the first statement to run in a test has
   * `index: 0`, the second `index: 1`, and so on. Unlike `seq`,
   * which is bumped by every raw event (enter/ok/throw/meta) and
   * therefore has gaps, `index` lets consumers reason about "the
   * Nth statement that ran" without tracking event-stream
   * arithmetic.
   */
  index: number;

  file: string;
  line: number;
  endLine: number;
  kind: string;
  scope: string;
  source: string;
  hasAwait: boolean;

  /**
   * User-written source comments (`// …` or `/* … *\/`) that Babel's
   * parser attached to this statement's AST node, joined with `\n`
   * in source order, with a single leading/trailing space stripped
   * from each comment value. Absent from the JSON when the node has
   * no attached comments (the field is never `null` or `""`).
   *
   * Intended as a best-effort intent hint — the autopilot agent and
   * humans debugging a failing test read this the same way they
   * would read the comment above a step in the source file.
   *
   * Attachment caveat: Babel assigns a same-line trailing comment
   * of statement N as a *leading* comment of statement N+1 when the
   * two are separated only by whitespace. `foo(); // about foo\n
   * bar();` therefore surfaces `about foo` on `bar()`, not `foo()`.
   * Treat the field accordingly.
   */
  leadingComment?: string;

  /** Innermost test.step title, or null if not inside one. */
  step: string | null;
  /** Full chain of enclosing test.step titles. */
  stepPath: string[] | null;

  status: 'ok' | 'threw';
  /** Milliseconds the statement took to execute. */
  duration: number;
  /** Relative start time in ms (from test.startedAt). */
  t: number;
  pageUrl?: string;

  /** Snapshot of bindings introduced by `const`/`let` that succeeded. */
  vars?: Record<string, unknown>;
  /** Present only when status === 'threw'. */
  error?: StatementError;

  /**
   * Filename (relative to the test's heal-data directory) of the
   * highlight screenshot captured by locator-screenshots while this
   * statement was running. Present only for statements that call a
   * patched Locator action (`click`, `fill`, `hover`, …) or a
   * wrapped assertion.
   */
  screenshot?: string;

  /**
   * Statements executed inside this one. Sorted by execution order
   * (`seq`). Empty for leaves.
   */
  children: Statement[];
}

export interface TestResultRecord {
  kind: 'test-result';
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  /** Total test duration in ms, as reported by Playwright's TestInfo. */
  duration: number;
  stdout?: string[];
  stderr?: string[];
  /**
   * Present only when this record was synthesized by the optional
   * `heal-reporter` after a worker crash (OOM, SIGKILL, segfault,
   * `process.exit()`). Carries the classified crash cause. The
   * fixture-written `test-result` never sets this — so presence of
   * the field is itself the signal that the test did not reach
   * normal teardown.
   */
  error?: StatementError;
}

/**
 * Optional record appended AFTER `test-result` by the
 * `HealTracerReporter` (Playwright Reporter API). Carries the list
 * of files Playwright produced for the test — `trace.zip`, video,
 * Playwright-taken failure screenshots, and any user attachments
 * pushed via `testInfo.attach()`.
 *
 * Written from the reporter (not the fixture) because Playwright
 * populates `testInfo.attachments` AFTER our `_traceAuto` fixture's
 * teardown — the reporter's `onTestEnd` is the first hook where
 * `result.attachments` is final.
 *
 * Absent when the reporter is not registered. Absence is not an
 * error — the trace is still complete; downstream tools should
 * treat the attachment list as empty.
 */
export interface TestAttachmentsRecord {
  kind: 'test-attachments';
  attachments: TestAttachment[];
}

export interface TestAttachment {
  /**
   * Playwright's attachment name. Common values: `'trace'` (for
   * trace.zip), `'video'`, `'screenshot'`. User attachments use the
   * label passed to `testInfo.attach(name, …)`.
   */
  name: string;
  /**
   * Path to the attachment file, RELATIVE to the test's outputDir
   * (the parent of `heal-data/`). Forward slashes on every platform.
   * Attachments outside the outputDir (rare; users could attach an
   * arbitrary path via `testInfo.attach({ path })`) are dropped.
   */
  path: string;
  /** MIME type (e.g. `'application/zip'`, `'image/png'`, `'video/webm'`). */
  contentType: string;
  /**
   * Video attachments only: a synthetic role label for the page this
   * video recorded — `'main'` for the test's primary page, `'page-1'`,
   * `'page-2'`, … for any other page in open order. Lets consumers tell
   * apart the multiple `video/*` files a multi-page test produces.
   * Absent for non-video attachments, and for videos the fixture could
   * not map back to a page (best-effort; e.g. the page was closed
   * before teardown).
   */
  pageName?: string;
  /**
   * Video attachments only: the page's URL captured at fixture
   * teardown (the last URL the test left the page on). Same
   * presence rules as `pageName`.
   */
  pageUrl?: string;
}

/**
 * Optional record appended by the in-worker fixture (BEFORE
 * `test-result`) when source-capture is enabled via
 * `configureTracer({ source: { enabled: true } })`. Carries a manifest
 * of every source file in the test's transitive import graph — the
 * spec plus every user file it imports (excluding `node_modules` and
 * out-of-root paths).
 *
 * The manifest stores PATHS ONLY. The file contents themselves live on
 * disk under the per-test `sources/` directory (a sibling of
 * `screenshots/` and `videos/`), so the NDJSON stays small and the
 * trace dir remains the single source of truth. Consumers (the
 * autopilot agent reading NDJSON directly, the local viewer server)
 * read content from disk by joining `<rootDir>/<path>`.
 *
 * Absent when source-capture is disabled. Absence is not an error —
 * the trace is still complete; downstream tools should treat the
 * source list as empty.
 */
export interface TestSourceRecord {
  kind: 'test-source';
  files: TestSourceFile[];
}

export interface TestSourceFile {
  /**
   * Path RELATIVE to the per-test directory (the parent of `sources/`),
   * using forward slashes on every platform. The corresponding file
   * lives at `<testDir>/<path>` — typically `sources/<project-rel>`
   * where `<project-rel>` mirrors the file's project-relative path
   * (e.g. `sources/tests/foo.spec.ts`, `sources/pages/login.ts`).
   */
  path: string;
  /** Byte size of the captured file (after read). */
  bytes: number;
  /** True for the spec file itself (the entry of the import graph). */
  entry?: boolean;
  /**
   * True when the file exceeded `maxFileBytes` and was NOT written to
   * disk. The manifest entry still records its existence + size for
   * inventory purposes; consumers reading from disk will get 404.
   */
  truncated?: boolean;
}

/**
 * Normalized error attached to a statement whose status is `threw`.
 * Decoupled from the runtime `SerializedError` type so consumers of
 * `heal-traces.ndjson` can import this schema without reaching into
 * internal modules.
 */
export interface StatementError {
  name?: string;
  message: string;
  stack?: string;
  /**
   * True when the error originated from Playwright itself (timeouts,
   * locator failures, expect mismatches) as opposed to user code.
   */
  isPlaywrightError?: boolean;
  /** Walked `.cause` chain, up to 5 levels deep. */
  causes?: StatementErrorCause[];
}

export interface StatementErrorCause {
  name?: string;
  message: string;
  stack?: string;
}
