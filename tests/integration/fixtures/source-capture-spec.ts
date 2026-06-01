/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Spec + helper used by `tests/integration/specs/source-capture.test.ts`.
//
// The spec imports a local helper so the tracer's import-graph
// resolver has a non-trivial graph to walk: the spec file (entry)
// plus the helper. Both files live under `tests/` so the on-disk
// shape mirrors the typical user layout (entry + page-object/helper
// next to it).

export const SOURCE_CAPTURE_SPEC = `import { test } from '@playwright/test';
import { greet } from './helper';

test('captures source for the whole import graph', async () => {
  // Use the helper so its presence isn't dead-code-eliminated by
  // overly clever tooling. (Babel doesn't DCE imports here, but the
  // pattern matches what a real spec would do.)
  greet('source-capture');
});
`;

export const SOURCE_CAPTURE_HELPER = `export function greet(name: string): string {
  return 'hello, ' + name;
}
`;
