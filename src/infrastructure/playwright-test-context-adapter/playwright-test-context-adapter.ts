/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Feature: capture per-test Playwright metadata into the runtime.
//
// Called once per test from the fixture. The runtime merges this with
// the static context (pid, gitSha, …) on the next reset() to produce
// the `meta` event at the top of each trace.
//
// Correlation identifiers under `TestHeader.context`:
//
//   - testId    — Playwright's `testInfo.testId` (a stable hash of
//                 file + title + project). Distinct per test, shared
//                 across every attempt (first run + retries) of the
//                 same test, including retries that land in a
//                 different worker. This is the cross-worker
//                 correlation key.
//   - attempt   — 1-indexed attempt number = testInfo.retry + 1.
//   - testCaseId — optional heal test case id parsed from the
//                 `@heal-<id>` tag.
//
// Downstream consumers key per-test-attempt state on
// `(testId, attempt)`.

import type { TestInfo } from '@playwright/test';
import { HEAL_TAG_PREFIX } from './heal-tag-prefix';

export interface CapturedContext {
  testId: string;
  attempt: number;
  testCaseId?: number;
}

export interface TestContextHooks {
  setContext(ctx: Record<string, unknown> | null): void;
}

export class PlaywrightTestContextAdapter {
  constructor(private readonly hooks: TestContextHooks) {}

  capture(testInfo: TestInfo): CapturedContext {
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

    this.hooks.setContext({
      workerIndex: testInfo.workerIndex,
      parallelIndex: testInfo.parallelIndex,
      testId: testInfo.testId,
      testTitle: testInfo.title,
      titlePath: testInfo.titlePath,
      projectName: testInfo.project.name,
      testFile: testInfo.file,
      retry: testInfo.retry,
      attempt,
      ...(testCaseId ? { testCaseId } : {}),
    });

    return {
      testId: testInfo.testId,
      attempt,
      ...(testCaseId ? { testCaseId } : {}),
    };
  }
}
