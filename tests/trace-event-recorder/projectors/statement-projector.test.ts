import { describe, it, expect } from 'vitest';
import { createStatementProjectorSink } from '../../../src/trace-event-recorder/projectors/statement-projector';
import type { HealTraceRecord } from '../../../src/trace-event-recorder/ports/heal-trace-sink';
import type {
  EnterEvent,
  MetaEvent,
  OkEvent,
} from '../../../src/trace-event-recorder/trace-schema';
import type {
  Statement,
  StatementRecord,
} from '../../../src/features/trace-output/statement-trace-schema';

// Collecting HealTraceSink used by every case.
function createRecordingSink() {
  const records: HealTraceRecord[] = [];
  return {
    records,
    sink: {
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
    runId: 'r',
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
    const { records, sink } = createRecordingSink();
    const projector = createStatementProjectorSink(sink);

    projector.write(metaEvent());
    projector.write(enterEvent({ leadingComment: 'click the button' }));
    projector.write(okEvent());

    const stmtRec = records.find((r) => r.kind === 'statement') as StatementRecord | undefined;
    expect(stmtRec).toBeDefined();
    expect(stmtRec!.statement.leadingComment).toBe('click the button');
  });

  it('omits leadingComment from the JSON shape when the enter event does not carry it', () => {
    const { records, sink } = createRecordingSink();
    const projector = createStatementProjectorSink(sink);

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

describe('statement-projector — testCaseId', () => {
  it('copies testCaseId from meta onto TestHeader.context', () => {
    const { records, sink } = createRecordingSink();
    const projector = createStatementProjectorSink(sink);

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
    const { records, sink } = createRecordingSink();
    const projector = createStatementProjectorSink(sink);

    projector.write(metaEvent());
    projector.write(enterEvent());
    projector.write(okEvent());

    const header = records.find((r) => r.kind === 'test-header');
    expect(header).toBeDefined();
    if (header!.kind !== 'test-header') return;
    expect(Object.prototype.hasOwnProperty.call(header!.test.context, 'testCaseId')).toBe(false);
  });
});
