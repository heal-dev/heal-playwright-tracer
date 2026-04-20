// Integration scenarios — end-to-end coverage of the pipeline
// branches the smoke test on its own doesn't reach.
//
// The shape:
//
//   - `beforeAll` runs `npx playwright test` ONCE against the sandbox
//     scaffolded by ./global-setup.ts. One scenario is designed to
//     fail, so Playwright exits with a non-zero status — we tolerate
//     that because the passing scenarios still produce their
//     heal-traces.ndjson files.
//
//   - All `heal-traces.ndjson` files under test-results/ are parsed
//     into a Map<testTitle, ParsedTrace>. Each line is one
//     HealTraceRecord (test-header, statement, test-result). The
//     parser reassembles them into a single `ParsedTrace` object so
//     assertions can walk a statement tree the way the old batched
//     JSON format allowed.
//
// Scenario → what it proves:
//
//   1. happy path click             → basic pipeline + statement.screenshot
//   2. failing assertion            → throw-event-builder + test-result.status='failed'
//   3. test step nesting            → step-tracking feature → stepPath on statements
//   4. variable declarations        → hoist transform + __ok({x}) + safeVars
//   5. nested helper call           → active-enter stack (depth > 0, parentSeq != null)
//   6. stdout and stderr capture    → test-stdout-capture feature → test-result.stdout/stderr
//
// Plus a shared assertion: every trace has a populated env block.

import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type {
  HealTraceRecord,
  Statement,
  StatementRecord,
  TestHeader,
  TestHeaderRecord,
  TestResultRecord,
} from '../../src/features/trace-output/statement-trace-schema';

/**
 * The shape the integration tests operate on: a single object per
 * test assembled from every line of its `heal-traces.ndjson`.
 */
interface ParsedTrace {
  schemaVersion: number;
  test: TestHeader & {
    status: TestResultRecord['status'];
    duration: number;
    stdout?: string[];
    stderr?: string[];
  };
  /** Root statements, in emission order. Nested calls live in each statement's `children`. */
  statements: Statement[];
}

let traces: Map<string, ParsedTrace>;

function* walkStatements(
  roots: readonly Statement[],
  parent: Statement | null = null,
): Generator<{ stmt: Statement; parent: Statement | null }> {
  for (const stmt of roots) {
    yield { stmt, parent };
    yield* walkStatements(stmt.children, stmt);
  }
}

function findStatement(
  trace: ParsedTrace,
  predicate: (stmt: Statement) => boolean,
): Statement | undefined {
  for (const { stmt } of walkStatements(trace.statements)) {
    if (predicate(stmt)) return stmt;
  }
  return undefined;
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function parseNdjsonTrace(filePath: string): ParsedTrace | null {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return null;

  let header: TestHeaderRecord | null = null;
  let result: TestResultRecord | null = null;
  const statements: Statement[] = [];

  for (const line of lines) {
    const record = JSON.parse(line) as HealTraceRecord;
    switch (record.kind) {
      case 'test-header':
        header = record;
        break;
      case 'statement':
        statements.push((record as StatementRecord).statement);
        break;
      case 'test-result':
        result = record;
        break;
    }
  }

  if (!header) return null;

  return {
    schemaVersion: header.schemaVersion,
    test: {
      ...header.test,
      status: result?.status ?? 'interrupted',
      duration: result?.duration ?? 0,
      stdout: result?.stdout,
      stderr: result?.stderr,
    },
    statements,
  };
}

function getTrace(title: string): ParsedTrace {
  const trace = traces.get(title);
  if (!trace) {
    const available = [...traces.keys()].join(', ') || '(none)';
    throw new Error(`No trace found for "${title}". Available titles: ${available}`);
  }
  return trace;
}

beforeAll(() => {
  const sandbox = process.env.INTEGRATION_SANDBOX;
  if (!sandbox) throw new Error('INTEGRATION_SANDBOX not set — globalSetup failed?');

  const testResultsDir = path.join(sandbox, 'test-results');
  if (fs.existsSync(testResultsDir)) {
    fs.rmSync(testResultsDir, { recursive: true, force: true });
  }

  // Run all scenarios in one Playwright invocation. Exactly one scenario
  // is designed to fail ('failing assertion'), so non-zero exit is
  // expected. The passing scenarios still produce their
  // heal-traces.ndjson files under their own test-results subdirectories.
  try {
    execSync('npx playwright test', {
      cwd: sandbox,
      env: process.env,
      stdio: 'pipe',
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
    if (e.status !== 1) {
      console.error('--- playwright stdout ---\n' + (e.stdout?.toString() ?? ''));
      console.error('--- playwright stderr ---\n' + (e.stderr?.toString() ?? ''));
      throw err;
    }
  }

  traces = new Map();
  for (const file of walk(testResultsDir)) {
    if (!file.endsWith('heal-traces.ndjson')) continue;
    const parsed = parseNdjsonTrace(file);
    if (parsed) traces.set(parsed.test.title, parsed);
  }

  if (traces.size === 0) {
    throw new Error(
      `No heal-traces.ndjson files found under ${testResultsDir}. ` +
        'Did the sandbox spec run at all?',
    );
  }
});

describe('integration: end-to-end scenarios', () => {
  it('1. happy path click — basic pipeline + statement.screenshot', () => {
    const trace = getTrace('happy path click');
    expect(trace.schemaVersion).toBe(1);
    expect(trace.test.status).toBe('passed');
    expect(trace.statements.length).toBeGreaterThan(0);

    // The click statement should carry its highlight screenshot inline.
    const clickWithScreenshot = findStatement(
      trace,
      (s) =>
        !!s.screenshot &&
        /highlight-\d+-(click|fill|hover|press|type|check|uncheck|focus|blur|tap|dblclick|selectOption|selectText|setInputFiles|setChecked|clear|dragTo|pressSequentially|scrollIntoViewIfNeeded)\.png$/.test(
          s.screenshot,
        ),
    );
    expect(clickWithScreenshot).toBeDefined();
    expect(clickWithScreenshot?.source).toMatch(/click/);

    // Locator assertions (expect(locator).toBeVisible() /
    // .toHaveText(...)) should also stamp a highlight screenshot on
    // their statement, tagged `assert-<method>`.
    const assertWithScreenshot = findStatement(
      trace,
      (s) => !!s.screenshot && /highlight-\d+-assert-\w+\.png$/.test(s.screenshot),
    );
    expect(assertWithScreenshot).toBeDefined();
    expect(assertWithScreenshot?.source).toMatch(/expect\(/);
  });

  it('2. failing assertion — test.status=failed and a statement with status=threw', () => {
    const trace = getTrace('failing assertion');
    expect(trace.test.status).toBe('failed');
    const threw = findStatement(trace, (s) => s.status === 'threw');
    expect(threw).toBeDefined();
    expect(threw?.error).toBeDefined();
    expect(threw?.error?.message).toMatch(/3/);
    expect(threw?.duration).toBeGreaterThanOrEqual(0);
  });

  it('3. test.step nesting — stepPath populated on inner statements', () => {
    const trace = getTrace('test step nesting');
    const nested = findStatement(trace, (s) => s.stepPath !== null && s.stepPath.length >= 2);
    expect(nested).toBeDefined();
    expect(nested?.stepPath).toEqual(['outer step', 'inner step']);
    expect(nested?.step).toBe('inner step');
  });

  it('4. variable declarations — vars captured on the const statement', () => {
    const trace = getTrace('variable declarations');
    const greetingStmt = findStatement(
      trace,
      (s) => s.kind === 'variable' && !!s.vars && 'greeting' in s.vars,
    );
    expect(greetingStmt).toBeDefined();
    expect(greetingStmt?.vars?.greeting).toBe('hello world');

    const answerStmt = findStatement(
      trace,
      (s) => s.kind === 'variable' && !!s.vars && 'answer' in s.vars,
    );
    expect(answerStmt).toBeDefined();
    expect(answerStmt?.vars?.answer).toBe(42);
  });

  it('5. nested helper call — at least one child statement with a parent in the tree', () => {
    const trace = getTrace('nested helper call');
    let deepest: { stmt: Statement; parent: Statement | null } | undefined;
    for (const entry of walkStatements(trace.statements)) {
      if (entry.parent !== null) {
        deepest = entry;
        break;
      }
    }
    expect(deepest).toBeDefined();
    expect(deepest?.parent).not.toBeNull();
    expect(deepest?.parent?.children).toContain(deepest?.stmt);
  });

  it('6. stdout and stderr capture — test.stdout/stderr contain the expected lines', () => {
    const trace = getTrace('stdout and stderr capture');
    const stdoutJoined = (trace.test.stdout ?? []).join('');
    const stderrJoined = (trace.test.stderr ?? []).join('');
    expect(stdoutJoined).toContain('hello from stdout');
    expect(stderrJoined).toContain('hello from stderr');
  });

  it('shared — every scenario trace has a populated env block', () => {
    for (const [title, trace] of traces.entries()) {
      expect(trace.test.env.nodeVersion, `env.nodeVersion missing for "${title}"`).toBeDefined();
      expect(trace.test.env.platform, `env.platform missing for "${title}"`).toBeDefined();
      expect(trace.test.env.pid, `env.pid missing for "${title}"`).toBeDefined();
    }
  });

  it('shared — every trace has a context with a UUID runId, attempt=1, and distinct runIds across tests', () => {
    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const seenRunIds = new Set<string>();
    for (const [title, trace] of traces.entries()) {
      expect(trace.test.context, `context missing for "${title}"`).toBeDefined();
      expect(trace.test.context.runId, `context.runId missing for "${title}"`).toMatch(uuidV4);
      // No retries configured in the sandbox, so first-attempt = 1.
      expect(trace.test.context.attempt, `context.attempt wrong for "${title}"`).toBe(1);
      // HEAL_EXECUTION_ID is not set during integration runs.
      expect(trace.test.context.executionId).toBeUndefined();
      seenRunIds.add(trace.test.context.runId);
    }
    // runId is per-test, so N distinct tests must yield N distinct runIds.
    expect(seenRunIds.size).toBe(traces.size);
  });
});
