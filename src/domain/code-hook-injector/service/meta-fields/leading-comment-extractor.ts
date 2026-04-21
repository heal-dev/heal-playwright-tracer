/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */

interface BabelComment {
  type: 'CommentLine' | 'CommentBlock';
  value: string;
}

interface NodeLike {
  leadingComments?: BabelComment[] | null;
}

export function extractLeadingComment(node: NodeLike | null | undefined): string | null {
  const comments = node?.leadingComments;
  if (!comments || comments.length === 0) return null;
  return comments.map((c) => stripOneSpace(c.value)).join('\n');
}

// Strip at most one leading and one trailing space. Not `.trim()` —
// that would destroy intentional indentation in JSDoc-style blocks
// where inner lines are `' * foo'`.
function stripOneSpace(value: string): string {
  return value.replace(/^ /, '').replace(/ $/, '');
}
