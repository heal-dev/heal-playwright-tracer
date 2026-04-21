/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 *
 */

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
//                   the generated UUID in a per-instance Map so a
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
import { HEAL_TAG_PREFIX } from './heal-tag-prefix';

export interface CapturedContext {
  runId: string;
  attempt: number;
  executionId?: string;
  testCaseId?: number;
}

export interface TestContextHooks {
  setContext(ctx: Record<string, unknown> | null): void;
}

export class PlaywrightTestContextAdapter {
  // Per-instance cache of testId → UUID so retries within the same
  // worker reuse the runId of the first attempt. The composition
  // root (the fixture) holds a single instance so this cache lives
  // for the worker's lifetime.
  private readonly runIdByTestId = new Map<string, string>();

  constructor(private readonly hooks: TestContextHooks) {}

  capture(testInfo: TestInfo): CapturedContext {
    const executionId = process.env.HEAL_EXECUTION_ID;
    const runId = this.runIdFor(testInfo.testId);
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

  private runIdFor(testId: string): string {
    const existing = this.runIdByTestId.get(testId);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    this.runIdByTestId.set(testId, fresh);
    return fresh;
  }
}
