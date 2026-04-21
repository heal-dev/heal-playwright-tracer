/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */

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
