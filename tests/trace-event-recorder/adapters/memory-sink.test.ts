import { describe, it, expect } from 'vitest';
import { createMemorySink } from '../../../src/trace-event-recorder/adapters/memory-sink';
import type { TraceEvent } from '../../../src/trace-event-recorder/trace-schema';

const a: TraceEvent = { type: 'meta', seq: 1, t: 0, wallTime: 0 };
const b: TraceEvent = { type: 'meta', seq: 2, t: 0, wallTime: 0 };
const injected: TraceEvent = { type: 'meta', seq: 99, t: 0, wallTime: 0 };

describe('MemorySink', () => {
  it('records writes and returns a copy from snapshot()', () => {
    const sink = createMemorySink();
    sink.write(a);
    sink.write(b);
    expect(sink.snapshot()).toEqual([a, b]);
  });

  it('snapshot() does not leak the internal array', () => {
    const sink = createMemorySink();
    sink.write(a);
    const snap = sink.snapshot();
    snap.push(injected);
    expect(sink.snapshot()).toEqual([a]);
  });

  it('clear() drops every previously written event', () => {
    const sink = createMemorySink();
    sink.write(a);
    sink.clear();
    expect(sink.snapshot()).toEqual([]);
    sink.write(b);
    expect(sink.snapshot()).toEqual([b]);
  });
});
