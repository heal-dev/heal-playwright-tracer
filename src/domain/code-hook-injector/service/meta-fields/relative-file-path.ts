/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */

import * as path from 'path';

export function relFile(cwd: string, absFile: string | undefined | null): string {
  if (!absFile) return '<anonymous>';
  const rel = path.relative(cwd, absFile);
  return rel && !rel.startsWith('..') ? rel : absFile;
}
