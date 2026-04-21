/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */

export type IncludeEntry = string | RegExp | ((filename: string) => unknown);
export type Include = IncludeEntry | IncludeEntry[] | null | undefined;
export type Matcher = (filename: string | undefined | null) => boolean;

export const defaultInclude: IncludeEntry[] = [/\/tests\//];

export function buildMatcher(include: Include): Matcher {
  const entries: IncludeEntry[] =
    include == null ? defaultInclude : Array.isArray(include) ? include : [include];
  return (filename) => {
    if (!filename) return false;
    for (const e of entries) {
      if (typeof e === 'string' && filename.includes(e)) return true;
      if (e instanceof RegExp && e.test(filename)) return true;
      if (typeof e === 'function' && e(filename)) return true;
    }
    return false;
  };
}
