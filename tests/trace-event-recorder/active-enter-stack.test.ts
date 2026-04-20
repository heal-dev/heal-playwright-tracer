import { describe, it, expect } from 'vitest';
import { createActiveEnterStack } from '../../src/trace-event-recorder/active-enter-stack';
import type { EnterEvent } from '../../src/trace-event-recorder/trace-schema';

function event(seq: number, extras: Partial<EnterEvent> = {}): EnterEvent {
  return {
    type: 'enter',
    seq,
    t: 0,
    wallTime: 0,
    parentSeq: null,
    depth: 0,
    file: 'f.ts',
    startLine: 1,
    startCol: 0,
    endLine: 1,
    endCol: 1,
    kind: 'expression',
    scope: 'test',
    hasAwait: false,
    source: '',
    step: null,
    stepPath: null,
    ...extras,
  };
}

describe('createActiveEnterStack', () => {
  it('starts empty: depth 0, parentSeq null, peek/pop undefined', () => {
    const stack = createActiveEnterStack();
    expect(stack.depth()).toBe(0);
    expect(stack.parentSeq()).toBe(null);
    expect(stack.peek()).toBeUndefined();
    expect(stack.pop()).toBeUndefined();
  });

  it('push increments depth and exposes the new top as peek()', () => {
    const stack = createActiveEnterStack();
    const a = event(1);
    stack.push(a);
    expect(stack.depth()).toBe(1);
    expect(stack.peek()).toBe(a);
  });

  it('parentSeq returns the seq of the current top', () => {
    const stack = createActiveEnterStack();
    stack.push(event(7));
    expect(stack.parentSeq()).toBe(7);
  });

  it('tracks depth across nested pushes', () => {
    const stack = createActiveEnterStack();
    stack.push(event(1));
    expect(stack.depth()).toBe(1);
    stack.push(event(2));
    expect(stack.depth()).toBe(2);
    stack.push(event(3));
    expect(stack.depth()).toBe(3);
  });

  it('parentSeq always reflects the innermost enter', () => {
    const stack = createActiveEnterStack();
    stack.push(event(1));
    stack.push(event(2));
    expect(stack.parentSeq()).toBe(2);
    stack.push(event(3));
    expect(stack.parentSeq()).toBe(3);
  });

  it('pop returns the most recent push and decrements depth', () => {
    const stack = createActiveEnterStack();
    const a = event(1);
    const b = event(2);
    stack.push(a);
    stack.push(b);
    expect(stack.pop()).toBe(b);
    expect(stack.depth()).toBe(1);
    expect(stack.pop()).toBe(a);
    expect(stack.depth()).toBe(0);
  });

  it('pop on an empty stack returns undefined (orphan tolerance)', () => {
    // The throw-event-builder relies on this: __throw firing before any
    // matching __enter must not crash — pop returns undefined and the
    // builder emits an orphan throw event with enterSeq: null.
    const stack = createActiveEnterStack();
    expect(stack.pop()).toBeUndefined();
  });

  it('clear drops every pushed event and resets depth to 0', () => {
    const stack = createActiveEnterStack();
    stack.push(event(1));
    stack.push(event(2));
    stack.push(event(3));
    stack.clear();
    expect(stack.depth()).toBe(0);
    expect(stack.peek()).toBeUndefined();
    expect(stack.parentSeq()).toBe(null);
  });

  it('is usable again after clear()', () => {
    const stack = createActiveEnterStack();
    stack.push(event(1));
    stack.clear();
    stack.push(event(42));
    expect(stack.depth()).toBe(1);
    expect(stack.parentSeq()).toBe(42);
  });
});
