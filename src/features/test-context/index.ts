// Feature: capture per-test Playwright metadata into the runtime.
//
// Called once per test from the fixture. The runtime merges this with
// the static context (pid, gitSha, …) on the next reset() to produce
// the `meta` event at the top of each trace.
//
// Also populates the correlation identifiers that end up under
// `TestHeader.context` in the NDJSON stream:
//
//   - runId       — UUIDv4 identifying ONE test. Shared across
//                   every attempt (first run + retries) of that
//                   test. We key by Playwright's `testInfo.testId`
//                   (a stable hash of file+title+project) and cache
//                   the generated UUID in a module-level Map so a
//                   retry re-running in the same worker sees the
//                   same id. Playwright retries in the same worker
//                   by default, so this is the common case.
//   - attempt     — 1-indexed attempt number = testInfo.retry + 1.
//   - executionId — optional external id from HEAL_EXECUTION_ID.
//                   When set, inherited by every worker spawned by
//                   `npx playwright test`, so every test in the run
//                   carries the same value. Omitted when unset.

import * as crypto from 'crypto';
import type { TestInfo } from '@playwright/test';
import { setContext } from '../../trace-event-recorder/entrypoint';

/**
 * Reserved Playwright tag prefix used to embed a Heal test case id on
 * a test. The suffix is the raw test case id, e.g. `@heal-tc_abc123`.
 *
 * This tag is the sole source of truth for linking a Playwright run
 * to a Heal test case — chosen over Playwright annotations because
 * tags are filterable from the CLI (`npx playwright test -g
 * "@heal-tc_abc|@heal-tc_def"`), which lets the backend trigger a
 * specific set of test cases without resolving file paths or line
 * numbers.
 *
 * Inheritance caveat: Playwright's `TestInfo.tags` merges tags from
 * the enclosing `test.describe(...)` block with tags on the
 * `test(...)` call itself, and provides no discriminator. Tagging a
 * describe with `@heal-*` therefore propagates the same id to every
 * test inside. We accept this at extraction time; the backend is
 * responsible for rejecting runs where a single testCaseId resolves
 * to multiple distinct testIds.
 */
export const HEAL_TAG_PREFIX = '@heal-';

const runIdByTestId = new Map<string, string>();

function runIdFor(testId: string): string {
  const existing = runIdByTestId.get(testId);
  if (existing) return existing;
  const fresh = crypto.randomUUID();
  runIdByTestId.set(testId, fresh);
  return fresh;
}

export interface CapturedContext {
  runId: string;
  attempt: number;
  executionId?: string;
  testCaseId?: number;
}

export function captureTestContext(testInfo: TestInfo): CapturedContext {
  const executionId = process.env.HEAL_EXECUTION_ID;
  const runId = runIdFor(testInfo.testId);
  const attempt = testInfo.retry + 1;
  const rawTagSuffix =
    testInfo.tags.find((t) => t.startsWith(HEAL_TAG_PREFIX))?.slice(HEAL_TAG_PREFIX.length) ?? '';
  // Only digits allowed — the backend schema stores testCaseId as
  // bigint. Anything else (empty, letters, negative, leading zeros
  // parsed to 0) is treated as "no id" so the run goes to the
  // unlinked bucket instead of silently mis-linking.
  const testCaseId = /^[1-9]\d*$/.test(rawTagSuffix)
    ? Number.parseInt(rawTagSuffix, 10)
    : undefined;

  setContext({
    workerIndex: testInfo.workerIndex,
    parallelIndex: testInfo.parallelIndex,
    testId: testInfo.testId,
    testTitle: testInfo.title,
    titlePath: testInfo.titlePath,
    projectName: testInfo.project.name,
    testFile: testInfo.file,
    retry: testInfo.retry,
    runId,
    attempt,
    ...(executionId ? { executionId } : {}),
    ...(testCaseId ? { testCaseId } : {}),
  });

  return {
    runId,
    attempt,
    ...(executionId ? { executionId } : {}),
    ...(testCaseId ? { testCaseId } : {}),
  };
}
