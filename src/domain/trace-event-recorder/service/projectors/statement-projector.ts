/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import type { TraceEvent, TraceEventConsumer } from '../../port/trace-event-consumer';
import type { EnterEvent, MetaEvent } from '../../model/trace-schema';
import type { HealTraceExporter } from '../../port/heal-trace-exporter';
import {
  HEAL_TRACE_SCHEMA_VERSION,
  type Statement,
  type TestContext,
  type TestEnv,
  type TestHeader,
  type TestResultRecord,
} from '../../model/statement-trace-schema';

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

export class StatementProjector implements TraceEventConsumer {
  // Every live statement, keyed by its enter-event seq. Used for
  // parent lookup on nested enters and for ok/throw stamping.
  private readonly allBySeq = new Map<number, LiveStatement>();
  // Subset: statements whose runtime parent was null. These are
  // the only ones that become their own NDJSON record.
  private readonly rootsBySeq = new Map<number, LiveStatement>();
  private headerEmitted = false;
  private finalized = false;

  constructor(private readonly output: HealTraceExporter) {}

  write(event: TraceEvent): void {
    if (this.finalized) return;
    switch (event.type) {
      case 'meta': {
        if (!this.headerEmitted) {
          this.output.write({
            kind: 'test-header',
            schemaVersion: HEAL_TRACE_SCHEMA_VERSION,
            test: buildTestHeader(event),
          });
          this.headerEmitted = true;
        }
        return;
      }

      case 'enter': {
        const live: LiveStatement = { stmt: createStatement(event), enter: event };
        this.allBySeq.set(event.seq, live);
        if (event.parentSeq == null) {
          this.rootsBySeq.set(event.seq, live);
        } else {
          const parent = this.allBySeq.get(event.parentSeq);
          if (parent) parent.stmt.children.push(live.stmt);
          // Orphaned (parent was never seen) — promote to root so
          // the statement is not lost.
          else this.rootsBySeq.set(event.seq, live);
        }
        return;
      }

      case 'ok': {
        const live = this.allBySeq.get(event.enterSeq);
        if (!live) return;
        live.stmt.duration = event.duration;
        if (event.vars) live.stmt.vars = event.vars;
        // Screenshot may have been stamped onto the enter event
        // after the enter was emitted (locator-screenshots
        // feature); pick it up now.
        if (live.enter.screenshot) live.stmt.screenshot = live.enter.screenshot;
        this.maybeEmitRoot(event.enterSeq, live);
        return;
      }

      case 'throw': {
        if (event.enterSeq == null) return;
        const live = this.allBySeq.get(event.enterSeq);
        if (!live) return;
        live.stmt.status = 'threw';
        live.stmt.duration = event.duration;
        live.stmt.error = event.error;
        if (live.enter.screenshot) live.stmt.screenshot = live.enter.screenshot;
        this.maybeEmitRoot(event.enterSeq, live);
        return;
      }

      default:
        return;
    }
  }

  // Called by `reset()` at the start of every test. Drops all
  // in-progress statement state so the next test begins with a
  // blank slate. Does NOT close the inner exporter — the fixture
  // owns that lifecycle.
  clear(): void {
    this.allBySeq.clear();
    this.rootsBySeq.clear();
    this.headerEmitted = false;
  }

  /**
   * Emit the final `test-result` record and close the underlying
   * exporter. Called once at test teardown; the projector is unusable
   * afterwards.
   */
  async finalize(result: Omit<TestResultRecord, 'kind'>): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.output.write({ kind: 'test-result', ...result });
    await this.output.close();
  }

  private maybeEmitRoot(seq: number, live: LiveStatement): void {
    if (!this.rootsBySeq.has(seq)) return;
    sortChildrenDeep(live.stmt);
    this.output.write({ kind: 'statement', statement: live.stmt });
    // Drop the subtree from the working maps — memory bound is
    // now the maximum in-flight depth rather than the whole test.
    this.dropSubtree(live.stmt);
    this.rootsBySeq.delete(seq);
  }

  private dropSubtree(stmt: Statement): void {
    this.allBySeq.delete(stmt.seq);
    for (const child of stmt.children) this.dropSubtree(child);
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
