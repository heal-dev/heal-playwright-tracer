import { describe, it, expect } from 'vitest';
import { createPerfHooksClock } from '../../../src/trace-event-recorder/adapters/perf-hooks-clock';

describe('createPerfHooksClock', () => {
  it('returns an object with a now() method', () => {
    const clock = createPerfHooksClock();
    expect(typeof clock.now).toBe('function');
  });

  it('now() returns a finite number', () => {
    const clock = createPerfHooksClock();
    const t = clock.now();
    expect(typeof t).toBe('number');
    expect(Number.isFinite(t)).toBe(true);
  });

  it('is monotonic — later calls return values >= earlier calls', () => {
    // perf_hooks.performance.now() is documented to be monotonic.
    // This test guards against someone accidentally swapping it for
    // Date.now() (which is NOT monotonic — NTP adjustments can rewind).
    const clock = createPerfHooksClock();
    const samples: number[] = [];
    for (let i = 0; i < 50; i++) samples.push(clock.now());
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]);
    }
  });
});
