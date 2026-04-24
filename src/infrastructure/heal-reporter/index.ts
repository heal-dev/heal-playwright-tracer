/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { HealTracerReporter } from './heal-tracer-reporter';

export { HealTracerReporter, HEAL_TRACE_CONTEXT_ANNOTATION } from './heal-tracer-reporter';
export type {
  HealTracerReporterDeps,
  HealTraceContext,
  RescueContext,
  RescueHook,
} from './heal-tracer-reporter';
export { CrashErrorClassifier } from './crash-error-classifier';
export type { TestInfoErrorLike } from './crash-error-classifier';
export { NdjsonTailInspector } from './ndjson-tail-inspector';

// Default export so users can register the reporter with the terse
// `reporter: [['@heal-dev/heal-playwright-tracer/reporter']]` form,
// matching how Playwright's own reporters are distributed.
export default HealTracerReporter;
