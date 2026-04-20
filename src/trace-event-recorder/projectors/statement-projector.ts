// Streaming statement projector.
//
// Sits between the trace-event-recorder (which emits raw
// `TraceEvent`s: meta/enter/ok/throw) and a `HealTraceSink` (which
// consumes `HealTraceRecord`s: test-header / statement / test-result).
//
// Shape:
//
//   recorder.sink ──▶  StatementProjectorSink (TraceSink)
//                           │
//                           ▼
//                     HealTraceSink  (e.g. Tee → [Ndjson, AgentHttp])
//
// Because it implements `TraceSink` it can be plugged into the
// recorder anywhere a MemorySink would have been. The projector
// owns the conversion.
//
// Incremental emission rules:
//
//   - On the first `meta` event after a `clear()`, emit exactly one
//     `test-header` record to the inner sink. Subsequent meta
//     events are ignored (defensive — there should only ever be
//     one per session).
//
//   - On `enter`: create a fresh `Statement` (with `status: 'ok'`,
//     empty `children`) and register it in `allBySeq`. If the
//     event's parentSeq is null (root), also register it in
//     `rootsBySeq`. Otherwise look up the parent in `allBySeq` and
//     push the new statement into its `children`; if the parent is
//     not found (shouldn't happen in practice — orphaned due to a
//     dropped throw) the statement is promoted to a root so it
//     isn't lost.
//
//   - On `ok`: stamp duration/vars on the matching statement. If
//     the statement is a root, this is the moment its subtree is
//     complete — write `{ kind: 'statement', statement }` to the
//     inner sink and drop it from the working maps.
//
//   - On `throw`: same as ok but stamp `status='threw'` and
//     `error`. Orphan throws (enterSeq === null) are dropped
//     silently; they are rare and Playwright's own reporting
//     catches them.
//
//   - On `clear()`: reset every internal map so the next test
//     starts with a blank slate. The inner sink is NOT closed —
//     sink lifecycle is the fixture's responsibility.
//
//   - `finalize()` is called by the fixture at test teardown with
//     the fields that were unknown when the test started (status,
//     duration, stdout/stderr). It writes a `test-result` record
//     and then awaits the inner sink's `close()`.
//
// The projector is deliberately not async: `write()` is a sync
// pass-through so event-builder code paths stay cheap. Only
// `finalize()` is async because `HealTraceSink.close()` may flush
// network I/O.

import type { TraceEvent, TraceSink } from '../ports/trace-sink';
import type { EnterEvent, MetaEvent } from '../trace-schema';
import type { HealTraceSink } from '../ports/heal-trace-sink';
import {
  HEAL_TRACE_SCHEMA_VERSION,
  type Statement,
  type TestContext,
  type TestEnv,
  type TestHeader,
  type TestResultRecord,
} from '../../features/trace-output/statement-trace-schema';

export interface StatementProjectorSink extends TraceSink {
  /**
   * Emit the final `test-result` record and close the underlying
   * sink. Called once at test teardown; the projector is unusable
   * afterwards.
   */
  finalize(result: Omit<TestResultRecord, 'kind'>): Promise<void>;
}

interface LiveStatement {
  stmt: Statement;
  /**
   * Reference to the enter event stored at push time. We keep it
   * because `setCurrentStatementScreenshot()` on the recorder
   * mutates the enter event after the projector has already seen
   * it; reading `enter.screenshot` at ok/throw time picks up that
   * late mutation without forcing the locator-screenshots feature
   * to know about the projector.
   */
  enter: EnterEvent;
}

export function createStatementProjectorSink(output: HealTraceSink): StatementProjectorSink {
  // Every live statement, keyed by its enter-event seq. Used for
  // parent lookup on nested enters and for ok/throw stamping.
  const allBySeq = new Map<number, LiveStatement>();
  // Subset: statements whose runtime parent was null. These are
  // the only ones that become their own NDJSON record.
  const rootsBySeq = new Map<number, LiveStatement>();
  let headerEmitted = false;
  let finalized = false;

  return {
    write(event: TraceEvent) {
      if (finalized) return;
      switch (event.type) {
        case 'meta': {
          if (!headerEmitted) {
            output.write({
              kind: 'test-header',
              schemaVersion: HEAL_TRACE_SCHEMA_VERSION,
              test: buildTestHeader(event),
            });
            headerEmitted = true;
          }
          return;
        }

        case 'enter': {
          const live: LiveStatement = { stmt: createStatement(event), enter: event };
          allBySeq.set(event.seq, live);
          if (event.parentSeq == null) {
            rootsBySeq.set(event.seq, live);
          } else {
            const parent = allBySeq.get(event.parentSeq);
            if (parent) parent.stmt.children.push(live.stmt);
            // Orphaned (parent was never seen) — promote to root so
            // the statement is not lost.
            else rootsBySeq.set(event.seq, live);
          }
          return;
        }

        case 'ok': {
          const live = allBySeq.get(event.enterSeq);
          if (!live) return;
          live.stmt.duration = event.duration;
          if (event.vars) live.stmt.vars = event.vars;
          // Screenshot may have been stamped onto the enter event
          // after the enter was emitted (locator-screenshots
          // feature); pick it up now.
          if (live.enter.screenshot) live.stmt.screenshot = live.enter.screenshot;
          maybeEmitRoot(event.enterSeq, live);
          return;
        }

        case 'throw': {
          if (event.enterSeq == null) return;
          const live = allBySeq.get(event.enterSeq);
          if (!live) return;
          live.stmt.status = 'threw';
          live.stmt.duration = event.duration;
          live.stmt.error = event.error;
          if (live.enter.screenshot) live.stmt.screenshot = live.enter.screenshot;
          maybeEmitRoot(event.enterSeq, live);
          return;
        }

        default:
          return;
      }
    },

    // The port requires snapshot() but the projector does not
    // retain a flat event log — raw events are consumed and
    // projected in one pass. Returning an empty array keeps the
    // port contract honoured without the semantic cost of holding
    // the data twice.
    snapshot() {
      return [];
    },

    // Called by `reset()` at the start of every test. Drops all
    // in-progress statement state so the next test begins with a
    // blank slate. Does NOT close the inner sink — the fixture
    // owns that lifecycle.
    clear() {
      allBySeq.clear();
      rootsBySeq.clear();
      headerEmitted = false;
    },

    async finalize(result) {
      if (finalized) return;
      finalized = true;
      output.write({ kind: 'test-result', ...result });
      await output.close();
    },
  };

  function maybeEmitRoot(seq: number, live: LiveStatement): void {
    if (!rootsBySeq.has(seq)) return;
    sortChildrenDeep(live.stmt);
    output.write({ kind: 'statement', statement: live.stmt });
    // Drop the subtree from the working maps — memory bound is
    // now the maximum in-flight depth rather than the whole test.
    dropSubtree(live.stmt);
    rootsBySeq.delete(seq);
  }

  function dropSubtree(stmt: Statement): void {
    allBySeq.delete(stmt.seq);
    for (const child of stmt.children) dropSubtree(child);
  }
}

function createStatement(event: EnterEvent): Statement {
  const stmt: Statement = {
    seq: event.seq,
    file: event.file,
    line: event.startLine,
    endLine: event.endLine,
    kind: event.kind,
    scope: event.scope,
    source: event.source,
    hasAwait: event.hasAwait,
    step: event.step,
    stepPath: event.stepPath,
    status: 'ok',
    duration: 0,
    t: event.t,
    pageUrl: event.pageUrl,
    children: [],
  };
  if (event.screenshot) stmt.screenshot = event.screenshot;
  if (event.leadingComment != null) stmt.leadingComment = event.leadingComment;
  return stmt;
}

function sortChildrenDeep(stmt: Statement): void {
  if (stmt.children.length === 0) return;
  stmt.children.sort((a, b) => a.seq - b.seq);
  for (const child of stmt.children) sortChildrenDeep(child);
}

function buildTestHeader(meta: MetaEvent): TestHeader {
  const env: TestEnv = {
    nodeVersion: meta.nodeVersion,
    platform: meta.platform,
    arch: meta.arch,
    hostname: meta.hostname,
    isCI: meta.isCI,
    cwd: meta.cwd,
    gitSha: meta.gitSha,
    pid: meta.pid,
  };
  const context: TestContext = {
    testId: meta.testId ?? '',
    runId: meta.runId ?? '',
    attempt: meta.attempt ?? 1,
    ...(meta.executionId ? { executionId: meta.executionId } : {}),
    ...(meta.testCaseId !== undefined ? { testCaseId: meta.testCaseId } : {}),
  };
  return {
    title: meta.testTitle ?? '',
    titlePath: meta.titlePath ?? [],
    file: meta.testFile ?? '',
    project: meta.projectName ?? '',
    workerIndex: meta.workerIndex ?? 0,
    retry: meta.retry ?? 0,
    startedAt: (meta.wallTime as number | undefined) ?? 0,
    env,
    context,
  };
}
