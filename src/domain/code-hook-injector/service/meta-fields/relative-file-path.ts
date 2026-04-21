/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 *
 */

// Computes the `meta.file` field: a repo-relative path when the
// absolute filename lives under the instrumenter's `rootDir` (or
// process.cwd() by default), or the absolute path otherwise.
//
// Relative paths make traces portable across machines; falling back
// to absolute when the file is outside the root avoids generating
// broken `..`-prefixed paths that can't be resolved on the consumer
// side. Missing filenames collapse to `<anonymous>` so downstream
// code never has to null-check.

import * as path from 'path';

export function relFile(cwd: string, absFile: string | undefined | null): string {
  if (!absFile) return '<anonymous>';
  const rel = path.relative(cwd, absFile);
  return rel && !rel.startsWith('..') ? rel : absFile;
}
