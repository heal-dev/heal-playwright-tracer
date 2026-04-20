import { describe, it, expect } from 'vitest';
import { buildMetaEvent } from '../../../src/trace-event-recorder/event-builders/meta-event-builder';
import { createTestRecorderState } from '../../helpers/trace-event-recorder-state';

const firstEvent = (state: { sink: { snapshot(): any[] } }) => state.sink.snapshot()[0] as any;

describe('buildMetaEvent', () => {
  it('writes an event of type "meta" to the sink', () => {
    const state = createTestRecorderState();
    buildMetaEvent(state);
    expect(firstEvent(state).type).toBe('meta');
  });

  it('stamps seq = current + 1 and increments state.seq', () => {
    const state = createTestRecorderState({ seq: 0 });
    buildMetaEvent(state);
    expect(firstEvent(state).seq).toBe(1);
    expect(state.seq).toBe(1);
  });

  it('sets t = 0 (meta events mark the origin of a run)', () => {
    const state = createTestRecorderState();
    buildMetaEvent(state);
    expect(firstEvent(state).t).toBe(0);
  });

  it('spreads the staticContext onto the event', () => {
    const state = createTestRecorderState({
      staticContext: {
        schemaVersion: 1,
        pid: 1234,
        nodeVersion: '20.0.0',
        platform: 'darwin',
      },
    });
    buildMetaEvent(state);
    const ev = firstEvent(state);
    expect(ev.schemaVersion).toBe(1);
    expect(ev.pid).toBe(1234);
    expect(ev.nodeVersion).toBe('20.0.0');
    expect(ev.platform).toBe('darwin');
  });

  it('spreads the dynamicContext on top of the staticContext', () => {
    const state = createTestRecorderState({
      staticContext: { pid: 1234 },
      dynamicContext: { testId: 't-42', testTitle: 'checkout' },
    });
    buildMetaEvent(state);
    const ev = firstEvent(state);
    expect(ev.pid).toBe(1234);
    expect(ev.testId).toBe('t-42');
    expect(ev.testTitle).toBe('checkout');
  });

  it('lets dynamicContext fields override staticContext fields', () => {
    // If the same key exists in both, the dynamic context wins
    // (per-test data is more specific than per-process data).
    const state = createTestRecorderState({
      staticContext: { testTitle: '<static default>' },
      dynamicContext: { testTitle: 'actual test title' },
    });
    buildMetaEvent(state);
    expect(firstEvent(state).testTitle).toBe('actual test title');
  });

  it('handles dynamicContext = null (only staticContext is emitted)', () => {
    const state = createTestRecorderState({
      staticContext: { pid: 1234 },
      dynamicContext: null,
    });
    buildMetaEvent(state);
    const ev = firstEvent(state);
    expect(ev.pid).toBe(1234);
    expect(ev.testId).toBeUndefined();
  });

  it('stamps wallTime as a finite number (Date.now)', () => {
    const state = createTestRecorderState();
    const before = Date.now();
    buildMetaEvent(state);
    const after = Date.now();
    expect(firstEvent(state).wallTime).toBeGreaterThanOrEqual(before);
    expect(firstEvent(state).wallTime).toBeLessThanOrEqual(after);
  });
});
