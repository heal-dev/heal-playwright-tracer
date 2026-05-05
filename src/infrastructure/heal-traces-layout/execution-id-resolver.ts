/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Resolves the per-process executionId once and caches it.
//
// Source priority:
//   1. process.env.HEAL_EXECUTION_ID (set this in CI to make every
//      shard share a single id)
//   2. randomUUID() — deterministic-enough fallback for local runs
//
// The result is memoized so repeat calls within a process return the
// same value, and so multiple Playwright workers spawned by the same
// runner all see one executionId per call (each worker is a separate
// node process; the runner's env is inherited).

import { randomUUID } from 'node:crypto';

export type ExecutionIdSource = 'env' | 'generated';

let cached: { id: string; source: ExecutionIdSource } | null = null;

const ENV_VAR = 'HEAL_EXECUTION_ID';

const compute = (): { id: string; source: ExecutionIdSource } => {
  const fromEnv = process.env[ENV_VAR];
  if (fromEnv && fromEnv.length > 0) {
    return { id: fromEnv, source: 'env' };
  }

  return { id: randomUUID(), source: 'generated' };
};

export const resolveExecutionId = (): string => {
  if (!cached) {
    cached = compute();
  }

  return cached.id;
};

export const getExecutionIdSource = (): ExecutionIdSource => {
  if (!cached) {
    cached = compute();
  }

  return cached.source;
};

/**
 * Reset the memoized executionId. Test-only — production code never
 * calls this. Allows unit tests to exercise both env-var and uuid
 * fallback paths within the same process.
 */
export const resetExecutionIdForTesting = (): void => {
  cached = null;
};
