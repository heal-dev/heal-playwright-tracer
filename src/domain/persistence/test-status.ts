/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Shared test-status enum: matches Playwright's TestResult.status,
// plus 'unknown' for the local-viewer's "no test-result on disk yet"
// case (worker crashed before the reporter ran).

export type TestStatus = 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted' | 'unknown';
