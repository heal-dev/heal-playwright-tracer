/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect } from 'vitest';
import { CrashErrorClassifier } from '../../../src/infrastructure/heal-reporter/crash-error-classifier';

const classifier = new CrashErrorClassifier();

describe('CrashErrorClassifier — OOM', () => {
  it('detects the Node heap-limit OOM banner in stderr', () => {
    const stderr =
      'some noise\n' +
      '<--- Last few GCs --->\n' +
      'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n' +
      '1: 0xabc123 node::Abort()\n';
    const err = classifier.classify([], stderr);
    expect(err.name).toBe('OutOfMemoryError');
    expect(err.message).toContain('heap out of memory');
    expect(err.stack).toContain('Allocation failed');
  });

  it('prefers the OOM signal over a generic "Worker process exited" in errors[]', () => {
    const stderr = 'FATAL ERROR: JavaScript heap out of memory\n';
    const err = classifier.classify(
      [{ message: 'Worker process exited unexpectedly (code=134 signal=null)' }],
      stderr,
    );
    expect(err.name).toBe('OutOfMemoryError');
  });
});

describe('CrashErrorClassifier — worker crash', () => {
  it('classifies a "Worker process exited unexpectedly" message as WorkerCrash', () => {
    const err = classifier.classify(
      [{ message: 'Worker process exited unexpectedly (code=null signal=SIGKILL)' }],
      '',
    );
    expect(err.name).toBe('WorkerCrash');
    expect(err.message).toContain('SIGKILL');
  });

  it('classifies a SIGSEGV-tagged message as WorkerCrash', () => {
    const err = classifier.classify(
      [{ message: 'Something terrible: SIGSEGV received', stack: 'native:0x0' }],
      '',
    );
    expect(err.name).toBe('WorkerCrash');
    expect(err.stack).toBe('native:0x0');
  });
});

describe('CrashErrorClassifier — fallbacks', () => {
  it('passes a non-crash error through serializeError', () => {
    const err = classifier.classify(
      [{ message: 'expect(received).toBe(expected)', stack: 'at Object.<anonymous>' }],
      '',
    );
    // serializeError falls back to the constructor name (`Object` for
    // the plain-object TestInfoError shape) when the error has no own
    // `name` — matches the behaviour used for regular throw events.
    expect(err.message).toBe('expect(received).toBe(expected)');
    expect(err.stack).toContain('at Object.<anonymous>');
  });

  it('synthesizes a diagnostic-less WorkerCrash when no signals are present', () => {
    const err = classifier.classify([], '');
    expect(err.name).toBe('WorkerCrash');
    expect(err.message).toBe('Worker terminated without diagnostic details');
  });
});
