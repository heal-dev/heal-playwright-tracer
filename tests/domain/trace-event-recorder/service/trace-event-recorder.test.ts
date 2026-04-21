/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 *
 */

import { describe, it, expect } from 'vitest';
import { buildHarness } from '../../../helpers/trace-event-recorder-harness';

function meta(overrides: Record<string, unknown> = {}) {
  return {
    file: 'tests/a.test.ts',
    startLine: 1,
    startCol: 0,
    endLine: 1,
    endCol: 10,
    kind: 'expression',
    scope: 'test: a',
    hasAwait: false,
    source: 'foo();',
    ...overrides,
  };
}

describe('createRecorder', () => {
  it('writes a meta event on reset() with merged static + dynamic context', () => {
    const { rt, events } = buildHarness({ schemaVersion: 1, pid: 1234 });
    rt.setContext({ testId: 't1', testTitle: 'first' });
    rt.reset();
    const [first] = events;
    expect(first.type).toBe('meta');
    expect(first.schemaVersion).toBe(1);
    expect(first.pid).toBe(1234);
    expect(first.testId).toBe('t1');
    expect(first.testTitle).toBe('first');
    expect(first.seq).toBe(1);
    expect(first.t).toBe(0);
  });

  it('pairs __enter with __ok (seq, enterSeq, depth, duration)', () => {
    const { rt, events, clock } = buildHarness();
    rt.reset();
    rt.__enter(meta());
    clock.advance(5);
    rt.__ok();
    expect(events.map((e: any) => e.type)).toEqual(['meta', 'enter', 'ok']);
    const [, enter, ok] = events;
    expect(enter.depth).toBe(0);
    expect(enter.parentSeq).toBe(null);
    expect(ok.enterSeq).toBe(enter.seq);
    expect(ok.duration).toBe(5);
  });

  it('tracks depth and parentSeq across nested __enter calls', () => {
    const { rt, events } = buildHarness();
    rt.reset();
    rt.__enter(meta({ source: 'outer' }));
    rt.__enter(meta({ source: 'inner' }));
    rt.__ok();
    rt.__ok();
    const [, outer, inner] = events;
    expect(outer.depth).toBe(0);
    expect(inner.depth).toBe(1);
    expect(inner.parentSeq).toBe(outer.seq);
  });

  it('emits a throw event with serialized error when __throw is called', () => {
    const { rt, events } = buildHarness();
    rt.reset();
    rt.__enter(meta());
    rt.__throw(new TypeError('boom'));
    const throwEvt = events.find((e: any) => e.type === 'throw');
    expect(throwEvt.error.name).toBe('TypeError');
    expect(throwEvt.error.message).toBe('boom');
    expect(typeof throwEvt.error.stack).toBe('string');
  });

  it('serializes variable snapshots passed to __ok', () => {
    const { rt, events } = buildHarness();
    rt.reset();
    rt.__enter(meta({ kind: 'variable' }));
    rt.__ok({ count: 42, name: 'alice' });
    const ok = events.find((e: any) => e.type === 'ok');
    expect(ok.vars).toEqual({ count: 42, name: 'alice' });
  });

  it('includes step context on every enter event (push/pop balanced)', () => {
    const { rt, events } = buildHarness();
    rt.reset();
    rt.pushStep('login');
    rt.__enter(meta());
    rt.__ok();
    rt.popStep();
    rt.__enter(meta());
    rt.__ok();
    const enters = events.filter((e: any) => e.type === 'enter');
    expect(enters[0].step).toBe('login');
    expect(enters[0].stepPath).toEqual(['login']);
    expect(enters[1].step).toBe(null);
    expect(enters[1].stepPath).toBe(null);
  });

  it('reads page.url() via setPage for the pageUrl field', () => {
    const { rt, events } = buildHarness();
    rt.reset();
    rt.setPage({ url: () => 'https://example.test/' });
    rt.__enter(meta());
    const enter = events.find((e: any) => e.type === 'enter');
    expect(enter.pageUrl).toBe('https://example.test/');
  });

  it('silently skips pageUrl when page.url() throws', () => {
    const { rt, events } = buildHarness();
    rt.reset();
    rt.setPage({
      url: () => {
        throw new Error('closed');
      },
    });
    rt.__enter(meta());
    const enter = events.find((e: any) => e.type === 'enter');
    expect(enter.pageUrl).toBeUndefined();
  });

  it('reset() clears previous events via exporter.clear()', () => {
    const { rt, events } = buildHarness();
    rt.reset();
    rt.__enter(meta());
    rt.__ok();
    expect(events.length).toBeGreaterThan(1);
    rt.reset();
    const after = events;
    expect(after).toHaveLength(1);
    expect(after[0].type).toBe('meta');
  });

  it('setCurrentStatementScreenshot stamps the filename on the top-of-stack enter event', () => {
    const { rt, events } = buildHarness();
    rt.reset();
    rt.__enter({
      file: 'f.ts',
      startLine: 1,
      startCol: 0,
      endLine: 1,
      endCol: 1,
      kind: 'expression',
      scope: 'test',
      hasAwait: false,
      source: 'await btn.click()',
    });
    rt.setCurrentStatementScreenshot('highlight-1-click.png');
    rt.__ok();

    const enter = events.find((e: any) => e.type === 'enter');
    expect(enter.screenshot).toBe('highlight-1-click.png');
  });

  it('setCurrentStatementScreenshot is a no-op when the stack is empty', () => {
    const { rt, events } = buildHarness();
    rt.reset();
    expect(() => rt.setCurrentStatementScreenshot('lost.png')).not.toThrow();
    const types = events.map((e: any) => e.type);
    expect(types).toEqual(['meta']);
  });

  it('__throw without a matching __enter is tolerated (no crash)', () => {
    const { rt, events } = buildHarness();
    rt.reset();
    expect(() => rt.__throw(new Error('orphan'))).not.toThrow();
    const throwEvt = events.find((e: any) => e.type === 'throw');
    expect(throwEvt.enterSeq).toBe(null);
    expect(throwEvt.duration).toBe(0);
  });
});
