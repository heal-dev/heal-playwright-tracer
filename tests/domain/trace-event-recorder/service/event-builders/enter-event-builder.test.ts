import { describe, it, expect } from 'vitest';
import { buildEnterEvent } from '../../../../../src/domain/trace-event-recorder/service/event-builders/enter-event-builder';
import {
  createTestRecorderState,
  createFakeClock,
} from '../../../../helpers/trace-event-recorder-state';
import type { EnterMeta } from '../../../../../src/domain/trace-event-recorder/model/enter-meta';

function sampleMeta(overrides: Partial<EnterMeta> = {}): EnterMeta {
  return {
    file: 'tests/a.test.ts',
    startLine: 10,
    startCol: 2,
    endLine: 10,
    endCol: 20,
    kind: 'expression',
    scope: 'test: sample',
    hasAwait: false,
    source: 'foo();',
    ...overrides,
  };
}

// Every test pokes at events[0] as `any` to dodge the
// TraceEvent index-signature typing noise.

const firstEvent = (state: { events: any[] }) => state.events[0] as any;

describe('buildEnterEvent', () => {
  it('writes an event of type "enter" to the exporter', () => {
    const state = createTestRecorderState();
    buildEnterEvent(state, sampleMeta());
    expect(state.events).toHaveLength(1);
    expect(firstEvent(state).type).toBe('enter');
  });

  it('stamps seq = current + 1 and increments state.seq', () => {
    const state = createTestRecorderState({ seq: 5 });
    buildEnterEvent(state, sampleMeta());
    expect(firstEvent(state).seq).toBe(6);
    expect(state.seq).toBe(6);
  });

  it('reads depth and parentSeq from the stack BEFORE push', () => {
    // First enter: stack empty → depth 0, parentSeq null
    const state = createTestRecorderState();
    buildEnterEvent(state, sampleMeta({ source: 'outer' }));
    const outer = firstEvent(state);
    expect(outer.depth).toBe(0);
    expect(outer.parentSeq).toBe(null);

    // Second (nested) enter while outer is still on the stack:
    // depth 1, parentSeq = outer.seq
    buildEnterEvent(state, sampleMeta({ source: 'inner' }));
    const inner = state.events[1] as unknown as Record<string, unknown>;
    expect(inner.depth).toBe(1);
    expect(inner.parentSeq).toBe(outer.seq);
  });

  it('pushes the new event onto the enter stack', () => {
    const state = createTestRecorderState();
    buildEnterEvent(state, sampleMeta());
    expect(state.enterStack.depth()).toBe(1);
    expect(state.enterStack.peek()).toBe(firstEvent(state));
  });

  it('computes `t` from clock.now() - startedAt', () => {
    const clock = createFakeClock(1000);
    const state = createTestRecorderState({ clock, startedAt: 1000 });
    clock.advance(42);
    buildEnterEvent(state, sampleMeta());
    expect(firstEvent(state).t).toBe(42);
  });

  it('spreads all EnterMeta fields onto the event', () => {
    const state = createTestRecorderState();
    buildEnterEvent(state, sampleMeta({ file: 'x.ts', kind: 'variable', hasAwait: true }));
    const ev = firstEvent(state);
    expect(ev.file).toBe('x.ts');
    expect(ev.kind).toBe('variable');
    expect(ev.hasAwait).toBe(true);
    expect(ev.startLine).toBe(10);
    expect(ev.source).toBe('foo();');
    expect(ev.scope).toBe('test: sample');
  });

  it('reads step and stepPath from state.stepStack', () => {
    const state = createTestRecorderState();
    state.stepStack.push('login');
    state.stepStack.push('fill form');
    buildEnterEvent(state, sampleMeta());
    const ev = firstEvent(state);
    expect(ev.step).toBe('fill form'); // innermost
    expect(ev.stepPath).toEqual(['login', 'fill form']);
  });

  it('sets step and stepPath to null when no step is active', () => {
    const state = createTestRecorderState();
    buildEnterEvent(state, sampleMeta());
    const ev = firstEvent(state);
    expect(ev.step).toBe(null);
    expect(ev.stepPath).toBe(null);
  });

  it('reads pageUrl from currentPage.url()', () => {
    const state = createTestRecorderState({
      currentPage: { url: () => 'https://example.test/' },
    });
    buildEnterEvent(state, sampleMeta());
    expect(firstEvent(state).pageUrl).toBe('https://example.test/');
  });

  it('leaves pageUrl undefined when currentPage is null', () => {
    const state = createTestRecorderState({ currentPage: null });
    buildEnterEvent(state, sampleMeta());
    expect(firstEvent(state).pageUrl).toBeUndefined();
  });

  it('leaves pageUrl undefined when currentPage has no url method', () => {
    const state = createTestRecorderState({ currentPage: {} });
    buildEnterEvent(state, sampleMeta());
    expect(firstEvent(state).pageUrl).toBeUndefined();
  });

  it('tolerates currentPage.url() throwing (returns undefined, does not crash)', () => {
    const state = createTestRecorderState({
      currentPage: {
        url: () => {
          throw new Error('page closed');
        },
      },
    });
    expect(() => buildEnterEvent(state, sampleMeta())).not.toThrow();
    expect(firstEvent(state).pageUrl).toBeUndefined();
  });

  it('stamps wallTime as a finite number (Date.now)', () => {
    const state = createTestRecorderState();
    const before = Date.now();
    buildEnterEvent(state, sampleMeta());
    const after = Date.now();
    const wall = firstEvent(state).wallTime;
    expect(wall).toBeGreaterThanOrEqual(before);
    expect(wall).toBeLessThanOrEqual(after);
  });

  it('spreads leadingComment through to the emitted event when present', () => {
    const state = createTestRecorderState();
    buildEnterEvent(state, sampleMeta({ leadingComment: 'click the button' }));
    expect(firstEvent(state).leadingComment).toBe('click the button');
  });

  it('leaves leadingComment undefined when the meta does not carry it', () => {
    const state = createTestRecorderState();
    buildEnterEvent(state, sampleMeta());
    expect(firstEvent(state).leadingComment).toBeUndefined();
  });
});
