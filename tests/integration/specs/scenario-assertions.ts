/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Shared `it()` assertions run by both `scenarios-disk.test.ts` and
// `scenarios-http.test.ts`.
//
// Both test files run the same six scenarios (see
// `../fixtures/scenario-spec`). The contract — what the projector
// must emit for each scenario — is identical regardless of which
// transport delivered the records to the assertion. Splitting the
// two routes while keeping a single assertions module catches
// divergence: if the disk path emits something the HTTP path doesn't
// (or vice versa), the same `expect` call fires in only one of the
// two files.
//
// `getTraces` is a lazy getter so the `describe` block can be set up
// at module load (vitest requires it) while the actual `Map` is
// populated by `beforeAll` in the importing test file.

import { describe, it, expect } from 'vitest';
import { type ParsedTrace, findStatement, walkStatements } from '../fixtures/parsed-trace';

export function runScenarioAssertions(
  label: string,
  getTraces: () => Map<string, ParsedTrace>,
): void {
  function getTrace(title: string): ParsedTrace {
    const traces = getTraces();
    const trace = traces.get(title);
    if (!trace) {
      const available = [...traces.keys()].join(', ') || '(none)';
      throw new Error(`No trace found for "${title}". Available titles: ${available}`);
    }
    return trace;
  }

  describe(`integration: end-to-end scenarios (${label})`, () => {
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
      let deepest: { stmt: ParsedTrace['statements'][number]; parent: unknown } | undefined;
      for (const entry of walkStatements(trace.statements)) {
        if (entry.parent !== null) {
          deepest = entry;
          break;
        }
      }
      expect(deepest).toBeDefined();
      expect(deepest?.parent).not.toBeNull();
      expect((deepest?.parent as { children: unknown[] }).children).toContain(deepest?.stmt);
    });

    it('6. stdout and stderr capture — test.stdout/stderr contain the expected lines', () => {
      const trace = getTrace('stdout and stderr capture');
      const stdoutJoined = (trace.test.stdout ?? []).join('');
      const stderrJoined = (trace.test.stderr ?? []).join('');
      expect(stdoutJoined).toContain('hello from stdout');
      expect(stderrJoined).toContain('hello from stderr');
    });

    it('shared — every scenario trace has a populated env block', () => {
      for (const [title, trace] of getTraces().entries()) {
        expect(trace.test.env.nodeVersion, `env.nodeVersion missing for "${title}"`).toBeDefined();
        expect(trace.test.env.platform, `env.platform missing for "${title}"`).toBeDefined();
        expect(trace.test.env.pid, `env.pid missing for "${title}"`).toBeDefined();
      }
    });

    it('shared — every trace has a context with a non-empty testId, attempt=1, and distinct testIds across tests', () => {
      const traces = getTraces();
      const seenTestIds = new Set<string>();
      for (const [title, trace] of traces.entries()) {
        expect(trace.test.context, `context missing for "${title}"`).toBeDefined();
        expect(trace.test.context.testId, `context.testId missing for "${title}"`).toMatch(/.+/);
        // No retries configured in the sandbox, so first-attempt = 1.
        expect(trace.test.context.attempt, `context.attempt wrong for "${title}"`).toBe(1);
        seenTestIds.add(trace.test.context.testId);
      }
      // testId is per-test (stable Playwright hash), so N distinct
      // tests must yield N distinct testIds.
      expect(seenTestIds.size).toBe(traces.size);
    });
  });
}
