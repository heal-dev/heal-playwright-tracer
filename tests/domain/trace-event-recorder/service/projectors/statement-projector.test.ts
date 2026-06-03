/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect, vi } from 'vitest';
import { StatementProjector } from '../../../../../src/domain/trace-event-recorder/service/projectors';
import type { HealTraceRecord } from '../../../../../src/domain/trace-event-recorder/port/heal-trace-exporter';
import type {
  EnterEvent,
  MetaEvent,
  OkEvent,
  ThrowEvent,
} from '../../../../../src/domain/trace-event-recorder/model/trace-schema';
import type {
  Statement,
  StatementRecord,
} from '../../../../../src/domain/trace-event-recorder/model/statement-trace-schema';

// Collecting HealTraceExporter used by every case.
function createRecordingExporter() {
  const records: HealTraceRecord[] = [];
  return {
    records,
    exporter: {
      write(r: HealTraceRecord) {
        records.push(r);
      },
      async close() {},
    },
  };
}

function metaEvent(): MetaEvent {
  return {
    type: 'meta',
    seq: 0,
    t: 0,
    wallTime: 1700000000000,
    schemaVersion: 1,
    testId: 'tid-1',
    attempt: 1,
    testTitle: 't',
    titlePath: ['t'],
    testFile: 'x.test.ts',
    projectName: 'default',
    workerIndex: 0,
    retry: 0,
  };
}

function enterEvent(overrides: Partial<EnterEvent> = {}): EnterEvent {
  return {
    type: 'enter',
    seq: 1,
    t: 10,
    wallTime: 1700000000010,
    parentSeq: null,
    depth: 0,
    file: 'x.test.ts',
    startLine: 5,
    startCol: 0,
    endLine: 5,
    endCol: 10,
    kind: 'expression',
    scope: 'test: t',
    hasAwait: false,
    source: 'foo();',
    step: null,
    stepPath: null,
    ...overrides,
  };
}

function okEvent(enterSeq = 1): OkEvent {
  return {
    type: 'ok',
    seq: 2,
    t: 15,
    wallTime: 1700000000015,
    enterSeq,
    duration: 5,
  };
}

describe('statement-projector — leadingComment', () => {
  it('copies leadingComment from the enter event onto the emitted Statement', () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);

    projector.write(metaEvent());
    projector.write(enterEvent({ leadingComment: 'click the button' }));
    projector.write(okEvent());

    const stmtRec = records.find((r) => r.kind === 'statement') as StatementRecord | undefined;
    expect(stmtRec).toBeDefined();
    expect(stmtRec!.statement.leadingComment).toBe('click the button');
  });

  it('omits leadingComment from the JSON shape when the enter event does not carry it', () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);

    projector.write(metaEvent());
    projector.write(enterEvent());
    projector.write(okEvent());

    const stmtRec = records.find((r) => r.kind === 'statement') as StatementRecord | undefined;
    expect(stmtRec).toBeDefined();
    // Field must be structurally absent (not `undefined`). The agent
    // distinguishes the two when reading NDJSON and an explicit
    // `"leadingComment": null` or the presence of the key at all
    // would be misleading.
    const stmt: Statement = stmtRec!.statement;
    expect(Object.prototype.hasOwnProperty.call(stmt, 'leadingComment')).toBe(false);
  });
});

describe('statement-projector — pageId / pageUrl', () => {
  it('copies pageId present on the enter event onto the Statement', () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);

    projector.write(metaEvent());
    projector.write(enterEvent({ pageId: 'ctx0/p0' }));
    projector.write(okEvent());

    const stmt = (records.find((r) => r.kind === 'statement') as StatementRecord).statement;
    expect(stmt.pageId).toBe('ctx0/p0');
  });

  it('picks up pageId / pageUrl stamped onto the enter event AFTER it was projected', () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);

    projector.write(metaEvent());
    const enter = enterEvent();
    projector.write(enter);
    // Simulate setCurrentStatementPage mutating the live enter event
    // mid-statement (the action fired after __enter, before __ok).
    enter.pageId = 'ctx1/p0';
    enter.pageUrl = 'https://app.test/dashboard';
    projector.write(okEvent());

    const stmt = (records.find((r) => r.kind === 'statement') as StatementRecord).statement;
    expect(stmt.pageId).toBe('ctx1/p0');
    expect(stmt.pageUrl).toBe('https://app.test/dashboard');
  });

  it('a late pageUrl stamp overrides the enter-time pageUrl', () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);

    projector.write(metaEvent());
    const enter = enterEvent({ pageUrl: 'https://app.test/login' });
    projector.write(enter);
    enter.pageUrl = 'https://app.test/after-action';
    projector.write(okEvent());

    const stmt = (records.find((r) => r.kind === 'statement') as StatementRecord).statement;
    expect(stmt.pageUrl).toBe('https://app.test/after-action');
  });

  it('omits pageId from the JSON shape when the statement touched no page', () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);

    projector.write(metaEvent());
    projector.write(enterEvent());
    projector.write(okEvent());

    const stmt = (records.find((r) => r.kind === 'statement') as StatementRecord).statement;
    expect(Object.prototype.hasOwnProperty.call(stmt, 'pageId')).toBe(false);
  });

  it('picks up a late pageId / pageUrl on the THROW path', () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);

    projector.write(metaEvent());
    const enter = enterEvent();
    projector.write(enter);
    enter.pageId = 'ctx0/p0';
    enter.pageUrl = 'https://app.test/failed';
    projector.write({
      type: 'throw',
      seq: 2,
      t: 20,
      wallTime: 1700000000020,
      enterSeq: 1,
      duration: 10,
      error: { message: 'boom' },
    } as ThrowEvent);

    const stmt = (records.find((r) => r.kind === 'statement') as StatementRecord).statement;
    expect(stmt.status).toBe('threw');
    expect(stmt.pageId).toBe('ctx0/p0');
    expect(stmt.pageUrl).toBe('https://app.test/failed');
  });

  it('picks up a late pageId when a pending root is flushed by finalize()', async () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);

    projector.write(metaEvent());
    const enter = enterEvent();
    projector.write(enter);
    // Stamp the page, but never emit ok/throw — finalize() must flush
    // the still-pending root and still carry the late page fields.
    enter.pageId = 'ctx2/p1';
    enter.pageUrl = 'https://app.test/hung';
    await projector.finalize({ status: 'timedOut', duration: 5000 });

    const stmt = (records.find((r) => r.kind === 'statement') as StatementRecord).statement;
    expect(stmt.status).toBe('threw');
    expect(stmt.pageId).toBe('ctx2/p1');
    expect(stmt.pageUrl).toBe('https://app.test/hung');
  });
});

describe('statement-projector — tree building', () => {
  it('nests child statements under their parent; parent subtree emitted once ok resolves the root', () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);

    projector.write(metaEvent());
    projector.write(enterEvent({ seq: 1, parentSeq: null, source: 'outer' }));
    projector.write(enterEvent({ seq: 2, parentSeq: 1, source: 'inner' }));
    projector.write(okEvent(2));
    // No statement record yet — root hasn't closed.
    expect(records.filter((r) => r.kind === 'statement')).toHaveLength(0);
    projector.write(okEvent(1));

    const [stmtRec] = records.filter((r) => r.kind === 'statement') as StatementRecord[];
    expect(stmtRec.statement.seq).toBe(1);
    expect(stmtRec.statement.children).toHaveLength(1);
    expect(stmtRec.statement.children[0].source).toBe('inner');
  });

  it('sortChildrenDeep orders nested children by seq regardless of completion order', () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);

    projector.write(metaEvent());
    projector.write(enterEvent({ seq: 1, parentSeq: null }));
    projector.write(enterEvent({ seq: 3, parentSeq: 1, source: 'second' }));
    projector.write(okEvent(3));
    projector.write(enterEvent({ seq: 2, parentSeq: 1, source: 'first' }));
    projector.write(enterEvent({ seq: 4, parentSeq: 2, source: 'nested' }));
    projector.write(okEvent(4));
    projector.write(okEvent(2));
    projector.write(okEvent(1));

    const [stmtRec] = records.filter((r) => r.kind === 'statement') as StatementRecord[];
    expect(stmtRec.statement.children.map((c) => c.seq)).toEqual([2, 3]);
    expect(stmtRec.statement.children[0].children.map((c) => c.seq)).toEqual([4]);
  });

  it('promotes an orphan enter (parent never seen) to a root so it is not lost', () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);

    projector.write(metaEvent());
    projector.write(enterEvent({ seq: 7, parentSeq: 999, source: 'orphan' }));
    projector.write(okEvent(7));

    const stmtRecs = records.filter((r) => r.kind === 'statement') as StatementRecord[];
    expect(stmtRecs).toHaveLength(1);
    expect(stmtRecs[0].statement.source).toBe('orphan');
  });
});

describe('statement-projector — throw handling', () => {
  function throwEvent(overrides: Partial<ThrowEvent> = {}): ThrowEvent {
    return {
      type: 'throw',
      seq: 3,
      t: 20,
      wallTime: 1700000000020,
      enterSeq: 1,
      duration: 10,
      error: { message: 'boom' },
      ...overrides,
    };
  }

  it('stamps status="threw", duration, and error on the matching statement', () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);

    projector.write(metaEvent());
    projector.write(enterEvent());
    projector.write(throwEvent());

    const [stmtRec] = records.filter((r) => r.kind === 'statement') as StatementRecord[];
    expect(stmtRec.statement.status).toBe('threw');
    expect(stmtRec.statement.duration).toBe(10);
    expect(stmtRec.statement.error).toEqual({ message: 'boom' });
  });

  it('drops orphan throws (enterSeq === null) silently without emitting a statement', () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);

    projector.write(metaEvent());
    projector.write(throwEvent({ enterSeq: null, seq: 2 }));

    expect(records.filter((r) => r.kind === 'statement')).toHaveLength(0);
  });

  it('ignores a throw whose enterSeq is unknown (no matching live statement)', () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);

    projector.write(metaEvent());
    projector.write(throwEvent({ enterSeq: 42 }));

    expect(records.filter((r) => r.kind === 'statement')).toHaveLength(0);
  });

  it('picks up a late-mutated enter.screenshot on throw', () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);
    const enter = enterEvent();

    projector.write(metaEvent());
    projector.write(enter);
    enter.screenshot = 'highlight-1.png';
    projector.write({
      type: 'throw',
      seq: 3,
      t: 20,
      wallTime: 1700000000020,
      enterSeq: 1,
      duration: 10,
      error: { message: 'late-shot' },
    });

    const [stmtRec] = records.filter((r) => r.kind === 'statement') as StatementRecord[];
    expect(stmtRec.statement.screenshot).toBe('highlight-1.png');
  });

  it('picks up a late-mutated enter.screenshot on ok', () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);
    const enter = enterEvent();

    projector.write(metaEvent());
    projector.write(enter);
    enter.screenshot = 'late-ok.png';
    projector.write(okEvent());

    const [stmtRec] = records.filter((r) => r.kind === 'statement') as StatementRecord[];
    expect(stmtRec.statement.screenshot).toBe('late-ok.png');
  });

  it('ignores an ok whose enterSeq is unknown', () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);

    projector.write(metaEvent());
    projector.write(okEvent(999));

    expect(records.filter((r) => r.kind === 'statement')).toHaveLength(0);
  });

  it('stores vars from the ok event on the statement', () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);

    projector.write(metaEvent());
    projector.write(enterEvent());
    projector.write({ ...okEvent(), vars: { count: 1 } });

    const [stmtRec] = records.filter((r) => r.kind === 'statement') as StatementRecord[];
    expect(stmtRec.statement.vars).toEqual({ count: 1 });
  });
});

describe('statement-projector — lifecycle', () => {
  it('emits a test-header only once across repeated meta events', () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);

    projector.write(metaEvent());
    projector.write(metaEvent());
    projector.write(metaEvent());

    expect(records.filter((r) => r.kind === 'test-header')).toHaveLength(1);
  });

  it('clear() resets header-emitted state so a new meta produces a fresh test-header', () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);

    projector.write(metaEvent());
    projector.write(enterEvent({ seq: 1 }));
    projector.write(okEvent(1));

    projector.clear();

    projector.write(metaEvent());
    projector.write(enterEvent({ seq: 2 }));
    projector.write(okEvent(2));

    const headers = records.filter((r) => r.kind === 'test-header');
    const statements = records.filter((r) => r.kind === 'statement') as StatementRecord[];
    expect(headers).toHaveLength(2);
    expect(statements.map((s) => s.statement.seq)).toEqual([1, 2]);
  });

  it('finalize() writes a test-result record and closes the inner exporter', async () => {
    const writes: HealTraceRecord[] = [];
    const close = vi.fn(async () => {});
    const projector = new StatementProjector({
      write: (r) => writes.push(r),
      close,
    });

    await projector.finalize({ status: 'passed', duration: 123, stdout: ['a'], stderr: [] });

    expect(writes).toEqual([
      { kind: 'test-result', status: 'passed', duration: 123, stdout: ['a'], stderr: [] },
    ]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('finalize() flushes pending root statements as threw with the provided error', async () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);

    projector.write(metaEvent());
    projector.write(
      enterEvent({ seq: 1, t: 100, source: 'await page.fill(...);', startLine: 34, endLine: 34 }),
    );

    const timeoutErr = new Error('Test timeout of 30000ms exceeded.');
    await projector.finalize({ status: 'timedOut', duration: 30000 }, timeoutErr);

    const statements = records.filter((r) => r.kind === 'statement') as StatementRecord[];
    expect(statements).toHaveLength(1);
    expect(statements[0].statement.seq).toBe(1);
    expect(statements[0].statement.status).toBe('threw');
    expect(statements[0].statement.duration).toBe(29900);
    expect(statements[0].statement.error?.message).toBe('Test timeout of 30000ms exceeded.');

    const resultIdx = records.findIndex((r) => r.kind === 'test-result');
    const stmtIdx = records.findIndex((r) => r.kind === 'statement');
    expect(stmtIdx).toBeLessThan(resultIdx);
  });

  it('finalize() synthesizes an error for pending roots when no pendingError is given', async () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);

    projector.write(metaEvent());
    projector.write(enterEvent({ seq: 1, t: 0 }));

    await projector.finalize({ status: 'failed', duration: 10 });

    const [stmtRec] = records.filter((r) => r.kind === 'statement') as StatementRecord[];
    expect(stmtRec.statement.status).toBe('threw');
    expect(stmtRec.statement.error?.message).toBe('Statement still pending when test ended');
  });

  it('finalize() does not flush a root that already emitted ok', async () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);

    projector.write(metaEvent());
    projector.write(enterEvent({ seq: 1, t: 0 }));
    projector.write(okEvent(1));

    await projector.finalize({ status: 'passed', duration: 10 }, new Error('x'));

    const statements = records.filter((r) => r.kind === 'statement') as StatementRecord[];
    expect(statements).toHaveLength(1);
    expect(statements[0].statement.status).toBe('ok');
  });

  it('finalize() is idempotent and blocks further events', async () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);
    await projector.finalize({ status: 'passed', duration: 1 });
    await projector.finalize({ status: 'failed', duration: 2 });

    // The ignored-after-finalize event should produce no record.
    projector.write(enterEvent({ seq: 99 }));
    projector.write(okEvent(99));

    const resultRecs = records.filter((r) => r.kind === 'test-result');
    expect(resultRecs).toHaveLength(1);
    expect(records.filter((r) => r.kind === 'statement')).toHaveLength(0);
  });
});

describe('statement-projector — testCaseId', () => {
  it('copies testCaseId from meta onto TestHeader.context', () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);

    projector.write({ ...metaEvent(), testCaseId: 42 });
    projector.write(enterEvent());
    projector.write(okEvent());

    const header = records.find((r) => r.kind === 'test-header');
    expect(header).toBeDefined();
    expect(header!.kind).toBe('test-header');
    if (header!.kind !== 'test-header') return;
    expect(header!.test.context.testCaseId).toBe(42);
  });

  it('omits testCaseId from TestHeader.context when meta does not carry it', () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);

    projector.write(metaEvent());
    projector.write(enterEvent());
    projector.write(okEvent());

    const header = records.find((r) => r.kind === 'test-header');
    expect(header).toBeDefined();
    if (header!.kind !== 'test-header') return;
    expect(Object.prototype.hasOwnProperty.call(header!.test.context, 'testCaseId')).toBe(false);
  });
});

describe('statement-projector — index', () => {
  it('stamps a 0-based contiguous index across roots and children in entry order', () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);

    // Mirrors the example trace in docs:
    //   root A (seq=2) → child B (seq=3) → root C (seq=10) with grandchild D
    // Indexes are entry-order, so A=0, B=1, C=2, D=3.
    projector.write(metaEvent());
    projector.write(enterEvent({ seq: 2, parentSeq: null, source: 'A' }));
    projector.write(enterEvent({ seq: 3, parentSeq: 2, source: 'B' }));
    projector.write(okEvent(3));
    projector.write(okEvent(2));
    projector.write(enterEvent({ seq: 10, parentSeq: null, source: 'C' }));
    projector.write(enterEvent({ seq: 11, parentSeq: 10, source: 'D' }));
    projector.write(okEvent(11));
    projector.write(okEvent(10));

    const stmts = records.filter((r) => r.kind === 'statement') as StatementRecord[];
    expect(stmts).toHaveLength(2);
    const [a, c] = stmts.map((s) => s.statement);
    expect(a.source).toBe('A');
    expect(a.index).toBe(0);
    expect(a.children[0].source).toBe('B');
    expect(a.children[0].index).toBe(1);
    expect(c.source).toBe('C');
    expect(c.index).toBe(2);
    expect(c.children[0].source).toBe('D');
    expect(c.children[0].index).toBe(3);
  });

  it('resets the counter back to 0 on clear() so each test starts fresh', () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);

    projector.write(metaEvent());
    projector.write(enterEvent({ seq: 1 }));
    projector.write(okEvent(1));

    projector.clear();

    projector.write(metaEvent());
    projector.write(enterEvent({ seq: 2 }));
    projector.write(okEvent(2));

    const stmts = records.filter((r) => r.kind === 'statement') as StatementRecord[];
    expect(stmts.map((s) => s.statement.index)).toEqual([0, 0]);
  });

  it('preserves the index assigned at enter-time when finalize() flushes a pending root', async () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);

    projector.write(metaEvent());
    projector.write(enterEvent({ seq: 1, t: 0, source: 'first' }));
    projector.write(okEvent(1));
    // Second root never gets an ok — finalize will flush it.
    projector.write(enterEvent({ seq: 3, t: 5, source: 'pending' }));

    await projector.finalize({ status: 'timedOut', duration: 100 });

    const stmts = records.filter((r) => r.kind === 'statement') as StatementRecord[];
    expect(stmts).toHaveLength(2);
    expect(stmts[0].statement.source).toBe('first');
    expect(stmts[0].statement.index).toBe(0);
    expect(stmts[1].statement.source).toBe('pending');
    expect(stmts[1].statement.index).toBe(1);
  });

  it('still increments index for orphan enters promoted to roots', () => {
    const { records, exporter } = createRecordingExporter();
    const projector = new StatementProjector(exporter);

    projector.write(metaEvent());
    projector.write(enterEvent({ seq: 1, parentSeq: null, source: 'root' }));
    projector.write(enterEvent({ seq: 2, parentSeq: 999, source: 'orphan' }));
    projector.write(okEvent(2));
    projector.write(okEvent(1));

    // Emission order is completion order: orphan's ok fires before
    // root's, so the orphan is emitted first. Index, however, was
    // stamped at enter time and reflects entry order.
    const stmts = records.filter((r) => r.kind === 'statement') as StatementRecord[];
    expect(stmts.map((s) => s.statement.source)).toEqual(['orphan', 'root']);
    const bySource = new Map(stmts.map((s) => [s.statement.source, s.statement.index]));
    expect(bySource.get('root')).toBe(0);
    expect(bySource.get('orphan')).toBe(1);
  });
});
