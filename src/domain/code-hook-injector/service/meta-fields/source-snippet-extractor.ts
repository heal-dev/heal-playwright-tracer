/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */

export const DEFAULT_MAX_SOURCE_LEN = 200;

interface NodeLike {
  start?: number | null;
  end?: number | null;
}

export function extractSource(
  code: string | undefined | null,
  node: NodeLike | null | undefined,
  maxLen: number = DEFAULT_MAX_SOURCE_LEN,
): string {
  const src = code || '';
  if (!node || node.start == null || node.end == null) return '';
  let snippet = src.slice(node.start, node.end);
  snippet = snippet.replace(/\s+/g, ' ').trim();
  if (snippet.length > maxLen) {
    snippet = snippet.slice(0, maxLen - 1) + '…';
  }
  return snippet;
}
