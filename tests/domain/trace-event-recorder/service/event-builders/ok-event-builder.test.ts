/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 */
import { describe, it, expect } from 'vitest';
import { buildEnterEvent } from '../../../../../src/domain/trace-event-recorder/service/event-builders/enter-event-builder';
import { buildOkEvent } from '../../../../../src/domain/trace-event-recorder/service/event-builders/ok-event-builder';
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
    source: 'foo();',
    ...overrides,
  };
}

describe('buildOkEvent', () => {
  it('writes an event of type "ok" to the exporter', () => {
    const state = createTestRecorderState();
    buildEnterEvent(state, sampleMeta());
    buildOkEvent(state);
    const types = state.events.map((e) => (e as { type: string }).type);
    expect(types).toEqual(['enter', 'ok']);
  });

  it('stamps seq = current + 1 and increments state.seq', () => {
    const state = createTestRecorderState();
    buildEnterEvent(state, sampleMeta()); // seq → 1
    buildOkEvent(state); // seq → 2
    const ok = state.events[1] as unknown as { seq: number };
    expect(ok.seq).toBe(2);
    expect(state.seq).toBe(2);
  });

  it('sets enterSeq to the matching enter event seq', () => {
    const state = createTestRecorderState();
    buildEnterEvent(state, sampleMeta());
    const enterSeq = (state.events[0] as unknown as { seq: number }).seq;
    buildOkEvent(state);
    const ok = state.events[1] as unknown as { enterSeq: number };
    expect(ok.enterSeq).toBe(enterSeq);
  });

  it('computes duration = (now - startedAt) - enter.t', () => {
    const clock = createFakeClock(1000);
    const state = createTestRecorderState({ clock, startedAt: 1000 });
    buildEnterEvent(state, sampleMeta());
    clock.advance(17);
    buildOkEvent(state);
    const ok = state.events[1] as unknown as { duration: number };
    expect(ok.duration).toBe(17);
  });

  it('pops the matching enter from the stack', () => {
    const state = createTestRecorderState();
    buildEnterEvent(state, sampleMeta());
    expect(state.enterStack.depth()).toBe(1);
    buildOkEvent(state);
    expect(state.enterStack.depth()).toBe(0);
  });

  it('attaches a serialized `vars` snapshot when vars are provided', () => {
    const state = createTestRecorderState();
    buildEnterEvent(state, sampleMeta({ kind: 'variable' }));
    buildOkEvent(state, { count: 42, name: 'alice' });
    const ok = state.events[1] as unknown as { vars?: Record<string, unknown> };
    expect(ok.vars).toEqual({ count: 42, name: 'alice' });
  });

  it('omits `vars` entirely when no vars are passed', () => {
    const state = createTestRecorderState();
    buildEnterEvent(state, sampleMeta());
    buildOkEvent(state);
    const ok = state.events[1] as unknown as Record<string, unknown>;
    expect('vars' in ok).toBe(false);
  });

  it('is a silent no-op when the stack is empty (orphan ok)', () => {
    const state = createTestRecorderState();
    buildOkEvent(state);
    expect(state.events).toHaveLength(0);
    expect(state.seq).toBe(0);
  });

  it('stamps wallTime as a finite number (Date.now)', () => {
    const state = createTestRecorderState();
    buildEnterEvent(state, sampleMeta());
    const before = Date.now();
    buildOkEvent(state);
    const after = Date.now();
    const ok = state.events[1] as unknown as { wallTime: number };
    expect(ok.wallTime).toBeGreaterThanOrEqual(before);
    expect(ok.wallTime).toBeLessThanOrEqual(after);
  });
});
