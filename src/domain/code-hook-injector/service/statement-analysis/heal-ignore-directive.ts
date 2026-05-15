/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Predicate: "is this statement under a `// @heal-tracer-ignore` directive?"
//
// The opt-out comment, analogous to `// @ts-ignore`. Authors annotate
// code the tracer should leave alone — most commonly a concurrent
// async callback (e.g. a `context.route` handler) whose repeated,
// interleaved invocations otherwise flood the trace and corrupt the
// shared enter-stack depth.
//
// Two scopes, decided purely by where Babel's parser attached the
// comment:
//
//   1. Statement — the directive sits directly above one leaf
//      statement. Only that statement is skipped; siblings are still
//      traced.
//
//        // @heal-tracer-ignore
//        await flaky();      // not traced
//        await stable();     // traced
//
//   2. Subtree — the directive sits above a function, arrow, block,
//      or compound statement. Every leaf inside it is skipped, because
//      the Statement visitor walks ancestor paths and finds the
//      directive on an enclosing node.
//
//        context.route(pred,
//          // @heal-tracer-ignore
//          async route => {
//            await route.continue(...);   // not traced
//          });
//
// Matching is a word-boundary search of each attached comment's text,
// so `/* @heal-tracer-ignore */`, `// @heal-tracer-ignore (vercel bypass)`, and a
// JSDoc line all work, while `@heal-tracer-ignored` does not.
//
// Only `leadingComments` are consulted — same source of truth as the
// leading-comment-extractor. A directive written as a same-line
// trailing comment will not register; keep it on its own line above
// the code it silences.

import type * as BabelTypes from '@babel/types';
import type { NodePath } from '@babel/traverse';

export const HEAL_IGNORE_DIRECTIVE = '@heal-tracer-ignore';

const DIRECTIVE_RE = /@heal-tracer-ignore\b/;

interface CommentedNode {
  leadingComments?: ReadonlyArray<{ value: string }> | null;
}

function hasDirectiveComment(node: BabelTypes.Node | null | undefined): boolean {
  const comments = (node as CommentedNode | null | undefined)?.leadingComments;
  if (!comments) return false;
  for (const comment of comments) {
    if (DIRECTIVE_RE.test(comment.value)) return true;
  }
  return false;
}

export function isUnderHealIgnore(path: NodePath<BabelTypes.Node>): boolean {
  for (let current: NodePath | null = path; current; current = current.parentPath) {
    if (hasDirectiveComment(current.node)) return true;
  }
  return false;
}
