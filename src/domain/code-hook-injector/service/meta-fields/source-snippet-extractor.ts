/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Extracts the raw source text for a node, collapsed and length-capped.
//
// Produces the `meta.source` field on every __enter event. Slicing
// the original file between `node.start` and `node.end` is cheap and
// avoids re-printing the AST; collapsing whitespace keeps multi-line
// statements readable on a single trace line; the 200-char cap keeps
// long expressions from blowing up the trace buffer.
//
// Synthetic statements injected by the plugin itself (e.g. the
// `__heal_expect_screenshot` helper line that fronts every traced
// `await expect(…)`) have no position in the user's file. They opt
// in to a precomputed source string via `_healSyntheticSource`,
// which this extractor uses verbatim (still collapsed + capped) so
// the trace shows a meaningful line instead of empty text.

export const DEFAULT_MAX_SOURCE_LEN = 200;

interface NodeLike {
  start?: number | null;
  end?: number | null;
  _healSyntheticSource?: string;
}

export function extractSource(
  code: string | undefined | null,
  node: NodeLike | null | undefined,
  maxLen: number = DEFAULT_MAX_SOURCE_LEN,
): string {
  if (!node) return '';
  let snippet: string;
  if (node._healSyntheticSource != null) {
    snippet = node._healSyntheticSource;
  } else {
    if (node.start == null || node.end == null) return '';
    snippet = (code || '').slice(node.start, node.end);
  }
  snippet = snippet.replace(/\s+/g, ' ').trim();
  if (snippet.length > maxLen) {
    snippet = snippet.slice(0, maxLen - 1) + '…';
  }
  return snippet;
}
