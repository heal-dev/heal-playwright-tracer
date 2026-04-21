/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 *
 */

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
// double-wrapping via a Symbol marker placed on the patched target.
//
// The runtime hooks are passed in by the composition root (the
// fixture) — this adapter is pure Playwright plumbing and must not
// reach back into application or domain modules.

const PATCHED = Symbol.for('heal-playwright-tracer.step-tracking.patched');

interface StepFn {
  (title: string, body: (...args: unknown[]) => unknown, opts?: unknown): unknown;
}

interface TestBaseWithStep {
  step?: StepFn;
  [PATCHED]?: boolean;
}

export interface StepHooks {
  pushStep(name: string): void;
  popStep(): void;
}

export class PlaywrightStepTrackingAdapter {
  constructor(private readonly hooks: StepHooks) {}

  patch(base: unknown): void {
    const target = base as TestBaseWithStep;
    if (target[PATCHED]) return;
    const origStep = target.step;
    if (typeof origStep !== 'function') return;
    target[PATCHED] = true;

    const hooks = this.hooks;
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
          hooks.pushStep(title);
          try {
            return await body(...args);
          } finally {
            hooks.popStep();
          }
        },
        opts,
      );
    };
  }
}
