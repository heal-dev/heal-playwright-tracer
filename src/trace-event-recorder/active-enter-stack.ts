// ActiveEnterStack — the push/pop structure that pairs every
// `__enter` with its matching `__ok` or `__throw`.
//
// This is the heart of the recorder. The stack is what makes
// `depth` and `parentSeq` meaningful on enter events: when an enter
// event is about to be pushed, we look at the current top of the
// stack to know who its parent is, and we use the current stack
// length as the depth. Pops happen on ok/throw so the next sibling
// enter sees the correct parent.
//
// Invariants:
//   - Every push MUST be matched by a pop. The instrumenter
//     guarantees this via the try/catch/finally wrapper: ok on
//     normal completion, throw on exception, both unwind through
//     finally — so return/break/continue inside a traced statement
//     still cause a matched pop.
//   - Orphan pops (pop with empty stack) are tolerated. The
//     throw-event-builder hits this when __throw fires before the
//     matching enter was emitted (e.g. an error escaping the very
//     first instrumented statement of a run).
//
// The stack is NOT safe for concurrent async stacks — two unrelated
// async chains running in parallel will interleave on this single
// stack and corrupt parentSeq. Documented in docs/the-lesson.md;
// the fix would be `AsyncLocalStorage`.

import type { EnterEvent } from './trace-schema';

export interface ActiveEnterStack {
  push(event: EnterEvent): void;
  pop(): EnterEvent | undefined;
  peek(): EnterEvent | undefined;
  depth(): number;
  parentSeq(): number | null;
  clear(): void;
}

export function createActiveEnterStack(): ActiveEnterStack {
  const stack: EnterEvent[] = [];
  return {
    push(event) {
      stack.push(event);
    },
    pop() {
      return stack.pop();
    },
    peek() {
      return stack[stack.length - 1];
    },
    depth() {
      return stack.length;
    },
    parentSeq() {
      if (stack.length === 0) return null;
      return stack[stack.length - 1].seq;
    },
    clear() {
      stack.length = 0;
    },
  };
}
