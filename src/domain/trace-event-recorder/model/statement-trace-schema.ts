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
//   3. Exactly one `test-result` record (last line). If it is
//      missing, the test crashed mid-run and the trace should be
//      treated as partial.
//
// The projector in `../../trace-event-recorder/projectors/
// statement-projector.ts` is what produces these records from the
// raw recorder event stream (enter/ok/throw/meta). Consumers (the
// Heal autopilot agent, humans debugging a failing test) should
// import these types to stay in sync with the file format.

export const HEAL_TRACE_SCHEMA_VERSION = 1;

/**
 * One line of a `heal-traces.ndjson` file. Discriminated by `kind`.
 */
export type HealTraceRecord = TestHeaderRecord | StatementRecord | TestResultRecord;

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
 * Playwright's `TestInfo` and from the `HEAL_EXECUTION_ID` env var.
 */
export interface TestContext {
  /**
   * Playwright's `testInfo.testId` — a stable hash of
   * (file, title, project). Distinct tests always get distinct
   * values; two attempts of the same test share this value.
   * Carried so the backend can detect when a single `testCaseId`
   * has been accidentally applied to multiple tests (typical
   * cause: `@heal-<id>` placed on a `test.describe(...)` block
   * and inherited by its children).
   */
  testId: string;
  /**
   * Auto-generated UUIDv4 identifying ONE test. Shared across every
   * attempt (first run + retries) of that test — keyed by
   * Playwright's `testInfo.testId` so retries re-running in the
   * same worker read the same value back. Two different tests
   * always get different runIds.
   */
  runId: string;
  /**
   * 1-indexed attempt number. Equal to `testInfo.retry + 1` — the
   * first run of a test is attempt 1, the first retry is attempt 2,
   * and so on.
   */
  attempt: number;
  /**
   * Optional external execution identifier sourced from the
   * `HEAL_EXECUTION_ID` env var. When set, inherited by every
   * worker spawned by a single `npx playwright test` invocation, so
   * every test in the run carries the same value. Intended for CI
   * pipelines that want to correlate a heal run with their own job
   * id. Omitted when the env var is not set.
   */
  executionId?: string;
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
