/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import * as path from 'path';

export function relFile(cwd: string, absFile: string | undefined | null): string {
  if (!absFile) return '<anonymous>';
  const rel = path.relative(cwd, absFile);
  return rel && !rel.startsWith('..') ? rel : absFile;
}
