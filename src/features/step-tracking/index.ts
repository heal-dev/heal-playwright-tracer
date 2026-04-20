// Feature: thread test.step titles onto the runtime step stack.
//
// `test.step("foo", async () => {...})` becomes:
//   runtime.pushStep("foo");
//   try { await body(); } finally { runtime.popStep(); }
//
// Every enter event emitted inside the body then carries `step: "foo"`
// and `stepPath: [...]` so the resulting trace can be grouped by step.
//
// Idempotent — the patch runs once per process and guards against
// double-wrapping via a Symbol marker.

import { pushStep, popStep } from '../../trace-event-recorder/entrypoint';

const PATCHED = Symbol.for('heal-playwright-tracer.step-tracking.patched');

interface StepFn {
  (title: string, body: (...args: unknown[]) => unknown, opts?: unknown): unknown;
}

interface TestBaseWithStep {
  step?: StepFn;
  [PATCHED]?: boolean;
}

export function patchTestStep(base: unknown): void {
  const target = base as TestBaseWithStep;
  if (target[PATCHED]) return;
  const origStep = target.step;
  if (typeof origStep !== 'function') return;
  target[PATCHED] = true;

  target.step = function patchedStep(
    this: unknown,
    title: string,
    body: (...args: unknown[]) => unknown,
    opts?: unknown,
  ) {
    return origStep.call(
      this,
      title,
      async (...args: unknown[]) => {
        pushStep(title);
        try {
          return await body(...args);
        } finally {
          popStep();
        }
      },
      opts,
    );
  };
}
