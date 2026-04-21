/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 *
 */

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
