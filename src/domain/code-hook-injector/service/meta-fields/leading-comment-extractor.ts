// Extracts user-written source comments attached to a statement.
//
// Produces the optional `meta.leadingComment` field on __enter
// events: the joined text of the `// …` or `/* … */` comments that
// Babel's parser attached to this statement's AST node. This is the
// successor of heal-cli's `StepExecutionEntry.comment`, which fed
// user intent hints (one-line descriptions above a step) to the
// autopilot agent.
//
// Babel stores each comment as `{ type, value }`, where `value` has
// already stripped `//` / `/* */` delimiters but still contains the
// leading space authors usually write (`// foo` → ` foo`). We strip
// exactly one space on each side per comment so the common case
// reads cleanly, while multi-line block comments keep their internal
// indentation. Multiple stacked comments are joined with `\n` in
// source order.
//
// Returns `null` when the node has no attached comments — the
// caller (enter-meta-literal) uses `null` as "omit the property
// entirely" so absent comments stay absent in the NDJSON instead of
// surfacing as `"leadingComment":null`.
//
// Attachment caveat: Babel's parser assigns a same-line trailing
// comment of statement N as a leading comment of statement N+1 when
// the two are separated only by whitespace (`foo(); // about foo\n
// bar();` → the comment lands on `bar`). This extractor does not
// try to re-attribute; consumers should treat the field as a
// best-effort intent hint, not an authoritative source location.

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
