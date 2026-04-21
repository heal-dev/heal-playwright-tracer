/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 *
 */

// Filename matcher for the tracer plugin.
//
// `include` accepts a single entry or an array. Each entry is one of:
//   - string   → matches if filename.includes(entry)
//   - RegExp   → matches if entry.test(filename)
//   - function → matches if entry(filename) is truthy
//
// When `include` is null/undefined the default policy instruments any
// file whose absolute path contains "/tests/".

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
