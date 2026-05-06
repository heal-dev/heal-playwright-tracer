/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Regression test: a console event fired while a statement is
// running must land inside that statement's [t, t+duration] window
// AND carry the same `seq` on its `statementSeq` correlation field.
//
// This is the contract every viewer / autopilot consumer relies on
// to interleave the streams. If timing math drifts (e.g. the session
// snapshots `startedAt` from a different clock than the recorder),
// this test fails.

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import type { BrowserContext, ConsoleMessage, Page } from 'playwright';
import { buildHarness } from '../../helpers/trace-event-recorder-harness';
import { ConsoleCaptureSession } from '../../../src/infrastructure/playwright-console-capture-adapter';

function readLines(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function makeFakeContext() {
  const ctxEmitter = new EventEmitter();
  const pageEmitter = new EventEmitter();
  const page = {
    on: pageEmitter.on.bind(pageEmitter),
    off: pageEmitter.off.bind(pageEmitter),
    url: () => 'https://example.test/',
    mainFrame: () => ({ url: () => 'https://example.test/' }),
  } as unknown as Page;
  const ctx = {
    on: ctxEmitter.on.bind(ctxEmitter),
    off: ctxEmitter.off.bind(ctxEmitter),
    pages: () => [page],
  } as unknown as BrowserContext;
  return { ctx, pageEmitter };
}

function makeMessage(text: string): ConsoleMessage {
  return {
    type: () => 'log',
    text: () => text,
    args: () => [],
    location: () => ({ url: '', lineNumber: 0, columnNumber: 0 }),
    page: () => null,
  } as unknown as ConsoleMessage;
}

describe('timestamp correlation: statement ↔ console sidecar', () => {
  let tmpDir: string;
  let ndjsonPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-corr-'));
    ndjsonPath = path.join(tmpDir, 'heal-console.ndjson');
  });

  it('console.t falls inside [statement.t, statement.t + duration] and statementSeq matches', async () => {
    const { rt, events, clock } = buildHarness();
    rt.reset(); // resets startedAt = clock.now() = 1000

    // Session shares the same clock and snapshots startedAt AFTER reset.
    const session = new ConsoleCaptureSession(
      ndjsonPath,
      {
        clock,
        startedAt: rt.getStartedAt(),
        getCurrentStatementSeq: rt.getCurrentStatementSeq,
        getCurrentStepPath: rt.getCurrentStepPath,
      },
      { enabled: true },
    );
    const { ctx, pageEmitter } = makeFakeContext();
    session.attachToContext(ctx);

    // Statement starts at t=10 (clock=1010, startedAt=1000).
    clock.advance(10);
    rt.__enter({
      file: 'a.test.ts',
      startLine: 1,
      startCol: 0,
      endLine: 1,
      endCol: 10,
      kind: 'expression',
      scope: 'test: x',
      hasAwait: false,
      source: 'await page.click()',
    });
    const enterEvent = events[events.length - 1];
    const enterSeq = enterEvent.seq;
    const enterT = enterEvent.t;
    expect(enterT).toBe(10);

    // Console message fires inside the statement at t=20.
    clock.advance(10);
    pageEmitter.emit('console', makeMessage('mid-statement'));
    await new Promise((r) => setImmediate(r));

    // Statement completes at t=30 (duration=20).
    clock.advance(10);
    rt.__ok();
    const okEvent = events[events.length - 1];
    expect(okEvent.duration).toBe(20);

    await session.close();

    const [record] = readLines(ndjsonPath) as Array<{
      t: number;
      statementSeq: number;
      text: string;
    }>;
    expect(record.text).toBe('mid-statement');
    // The console event's `t` is on the same axis as the statement's
    // `t` — both are `clock.now() - startedAt`.
    expect(record.t).toBe(20);
    expect(record.t).toBeGreaterThanOrEqual(enterT);
    expect(record.t).toBeLessThanOrEqual(enterT + okEvent.duration);
    // And `statementSeq` directly identifies the active statement.
    expect(record.statementSeq).toBe(enterSeq);
  });

  it('console event fired between statements has no statementSeq but a comparable t', async () => {
    const { rt, events, clock } = buildHarness();
    rt.reset();

    const session = new ConsoleCaptureSession(
      ndjsonPath,
      {
        clock,
        startedAt: rt.getStartedAt(),
        getCurrentStatementSeq: rt.getCurrentStatementSeq,
        getCurrentStepPath: rt.getCurrentStepPath,
      },
      { enabled: true },
    );
    const { ctx, pageEmitter } = makeFakeContext();
    session.attachToContext(ctx);

    // Run + complete a statement, leaving the active stack empty.
    clock.advance(5);
    rt.__enter({
      file: 'a.test.ts',
      startLine: 1,
      startCol: 0,
      endLine: 1,
      endCol: 1,
      kind: 'expression',
      scope: 'test: x',
      hasAwait: false,
      source: 'noop;',
    });
    clock.advance(5);
    rt.__ok();

    // Fire a console message AFTER the statement closed. The active
    // enter-stack is empty, so `statementSeq` should be omitted.
    clock.advance(10);
    pageEmitter.emit('console', makeMessage('between'));
    await new Promise((r) => setImmediate(r));
    await session.close();

    const [record] = readLines(ndjsonPath) as Array<{
      t: number;
      statementSeq?: number;
      text: string;
    }>;
    expect(record.text).toBe('between');
    expect(record.statementSeq).toBeUndefined();
    // Still on the same time axis — readers can sort by `t` alongside
    // statement records to render the event between two siblings.
    const lastOk = events[events.length - 1];
    expect(record.t).toBeGreaterThan(lastOk.t);
    void lastOk;
  });
});
