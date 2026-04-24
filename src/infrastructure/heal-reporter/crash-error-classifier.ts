/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Classifies a Playwright worker crash into a normalized `StatementError`.
//
// Input signals (combined by the reporter from main-process state):
//   - `errors`  — `TestResult.errors[]` from Playwright. On a hard
//                  worker death Playwright typically fabricates a
//                  single entry like "Worker process exited
//                  unexpectedly (code=null signal=SIGKILL)".
//   - `stderr`  — the concatenated worker stderr collected via
//                  `Reporter.onStdErr`. Node's OOM banner
//                  ("FATAL ERROR: … JavaScript heap out of memory")
//                  lands here, emitted by V8 right before abort.
//
// Classification order matters: OOM is detected FIRST because its
// banner often coexists with a generic "Worker process exited"
// message in `errors` — the more specific signal wins. Segfaults
// ride on the same SIGSEGV channel as SIGKILL so they share the
// `WorkerCrash` name.
//
// Output shape matches the `SerializedError` used everywhere else in
// the trace, so consumers can treat a reporter-synthesized crash the
// same way they treat a regular `status: 'threw'` error.

import { serializeError } from '../../domain/trace-event-recorder/service/serializers';
import type { StatementError } from '../../domain/trace-event-recorder/model/statement-trace-schema';

export interface TestInfoErrorLike {
  message?: string;
  stack?: string;
}

const OOM_BANNER =
  /FATAL ERROR:[^\n]*(?:Reached heap limit|heap out of memory|Allocation failed)[^\n]*/;
const WORKER_EXIT = /Worker process exited unexpectedly/i;
const FATAL_SIGNAL = /SIG(?:KILL|SEGV|ABRT|BUS)/;

export class CrashErrorClassifier {
  classify(errors: readonly TestInfoErrorLike[], stderr: string): StatementError {
    const oom = OOM_BANNER.exec(stderr);
    if (oom) {
      return {
        name: 'OutOfMemoryError',
        message: oom[0],
        stack: stderr.length > 0 ? stderr.slice(-4096) : undefined,
        isPlaywrightError: false,
      };
    }

    const first = errors[0];
    const firstMsg = first?.message ?? '';
    if (WORKER_EXIT.test(firstMsg) || FATAL_SIGNAL.test(firstMsg)) {
      return {
        name: 'WorkerCrash',
        message: firstMsg,
        stack: first?.stack,
        isPlaywrightError: false,
      };
    }

    if (first) {
      return serializeError(first);
    }

    return {
      name: 'WorkerCrash',
      message: 'Worker terminated without diagnostic details',
      isPlaywrightError: false,
    };
  }
}
