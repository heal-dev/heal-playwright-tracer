/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 */
import { describe, it, expect } from 'vitest';
import { buildEnterEvent } from '../../../../../src/domain/trace-event-recorder/service/event-builders/enter-event-builder';
import { buildThrowEvent } from '../../../../../src/domain/trace-event-recorder/service/event-builders/throw-event-builder';
import {
  createTestRecorderState,
  createFakeClock,
} from '../../../../helpers/trace-event-recorder-state';
import type { EnterMeta } from '../../../../../src/domain/trace-event-recorder/model/enter-meta';

function sampleMeta(overrides: Partial<EnterMeta> = {}): EnterMeta {
  return {
    file: 'tests/a.test.ts',
    startLine: 1,
    startCol: 0,
    endLine: 1,
    endCol: 6,
    kind: 'expression',
    scope: 'test: x',
    hasAwait: false,
    source: 'boom();',
    ...overrides,
  };
}

const lastEvent = (state: { events: any[] }) => {
  const snap = state.events;
  return snap[snap.length - 1];
};

describe('buildThrowEvent', () => {
  it('writes an event of type "throw" to the exporter', () => {
    const state = createTestRecorderState();
    buildEnterEvent(state, sampleMeta());
    buildThrowEvent(state, new Error('boom'));
    expect(lastEvent(state).type).toBe('throw');
  });

  it('stamps seq = current + 1 and increments state.seq', () => {
    const state = createTestRecorderState();
    buildEnterEvent(state, sampleMeta()); // seq → 1
    buildThrowEvent(state, new Error('boom')); // seq → 2
    expect(lastEvent(state).seq).toBe(2);
    expect(state.seq).toBe(2);
  });

  it('sets enterSeq to the popped enter event seq', () => {
    const state = createTestRecorderState();
    buildEnterEvent(state, sampleMeta());
    const enterSeq = (state.events[0] as unknown as { seq: number }).seq;
    buildThrowEvent(state, new Error('boom'));
    expect(lastEvent(state).enterSeq).toBe(enterSeq);
  });

  it('computes duration = (now - startedAt) - enter.t', () => {
    const clock = createFakeClock(1000);
    const state = createTestRecorderState({ clock, startedAt: 1000 });
    buildEnterEvent(state, sampleMeta());
    clock.advance(9);
    buildThrowEvent(state, new Error('boom'));
    expect(lastEvent(state).duration).toBe(9);
  });

  it('pops the matching enter from the stack', () => {
    const state = createTestRecorderState();
    buildEnterEvent(state, sampleMeta());
    buildThrowEvent(state, new Error('boom'));
    expect(state.enterStack.depth()).toBe(0);
  });

  it('attaches a serialized error with name, message, stack', () => {
    const state = createTestRecorderState();
    buildEnterEvent(state, sampleMeta());
    buildThrowEvent(state, new TypeError('bad type'));
    const ev = lastEvent(state);
    expect(ev.error.name).toBe('TypeError');
    expect(ev.error.message).toBe('bad type');
    expect(typeof ev.error.stack).toBe('string');
  });

  it('tolerates an orphan throw (no matching enter on the stack)', () => {
    // The throw-event-builder must NOT crash when __throw fires
    // before any __enter — an error escaping the very first
    // instrumented statement of a run hits this path.
    const state = createTestRecorderState();
    expect(() => buildThrowEvent(state, new Error('orphan'))).not.toThrow();
    const ev = lastEvent(state);
    expect(ev.type).toBe('throw');
    expect(ev.enterSeq).toBe(null);
    expect(ev.duration).toBe(0);
  });

  it('serializes non-Error throws (string, number, null)', () => {
    const state = createTestRecorderState();
    buildEnterEvent(state, sampleMeta());
    buildThrowEvent(state, 'just a string');
    const ev = lastEvent(state);
    expect(ev.error.message).toBe('just a string');
  });

  it('stamps wallTime as a finite number (Date.now)', () => {
    const state = createTestRecorderState();
    buildEnterEvent(state, sampleMeta());
    const before = Date.now();
    buildThrowEvent(state, new Error('x'));
    const after = Date.now();
    const ev = lastEvent(state);
    expect(ev.wallTime).toBeGreaterThanOrEqual(before);
    expect(ev.wallTime).toBeLessThanOrEqual(after);
  });
});
