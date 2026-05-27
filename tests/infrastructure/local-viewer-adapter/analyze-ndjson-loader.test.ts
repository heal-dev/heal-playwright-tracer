/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadAnalyzeNdjson } from '../../../src/infrastructure/local-viewer-adapter/analyze-ndjson-loader';
import type { AnalyzeEvent } from '../../../src/infrastructure/local-viewer-adapter/local-server-api-types';

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'analyze-ndjson-loader-'));
});

afterAll(async () => {
  // Each test writes a uniquely-named file under workDir; tmp dirs are
  // cleaned up by the OS on reboot. No explicit unlink needed.
});

const writeFixture = async (name: string, lines: AnalyzeEvent[] | string[]): Promise<string> => {
  const filePath = path.join(workDir, `${name}.ndjson`);
  const body = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
  await writeFile(filePath, body, 'utf-8');

  return filePath;
};

describe('loadAnalyzeNdjson', () => {
  it('returns null when the file does not exist', async () => {
    const result = await loadAnalyzeNdjson(path.join(workDir, 'does-not-exist.ndjson'));
    expect(result).toBeNull();
  });

  it('returns empty events/null terminal for an empty file', async () => {
    const fp = await writeFixture('empty', []);
    const result = await loadAnalyzeNdjson(fp);
    expect(result).toEqual({ events: [], terminal: null });
  });

  it('returns started event with terminal null when only `started` is present', async () => {
    const started: AnalyzeEvent = { event: 'started', timestamp: 1000 };
    const fp = await writeFixture('started-only', [started]);
    const result = await loadAnalyzeNdjson(fp);
    expect(result?.events).toEqual([started]);
    expect(result?.terminal).toBeNull();
  });

  it('returns verdict as terminal on the happy path', async () => {
    const started: AnalyzeEvent = { event: 'started', timestamp: 1000 };
    const verdict: AnalyzeEvent = {
      event: 'verdict',
      timestamp: 2000,
      verdict: {
        verdictType: 'BUG',
        failingStatementIndex: 3,
        description: 'Click did not navigate',
        reasoning: 'expected URL to change',
        model: 'opus-4.6-high',
        latencyMs: 24210,
      },
    };
    const fp = await writeFixture('verdict', [started, verdict]);
    const result = await loadAnalyzeNdjson(fp);
    expect(result?.events).toEqual([started, verdict]);
    expect(result?.terminal).toEqual(verdict);
  });

  it('returns error as terminal on the failure path', async () => {
    const started: AnalyzeEvent = { event: 'started', timestamp: 1000 };
    const err: AnalyzeEvent = {
      event: 'error',
      timestamp: 1500,
      message: 'LLM call timed out',
    };
    const fp = await writeFixture('error', [started, err]);
    const result = await loadAnalyzeNdjson(fp);
    expect(result?.terminal).toEqual(err);
  });

  it('picks the FIRST terminal event when both a verdict and an error are present', async () => {
    const verdict: AnalyzeEvent = {
      event: 'verdict',
      timestamp: 2000,
      verdict: {
        verdictType: 'NO_VERDICT',
        failingStatementIndex: 0,
        description: '',
      },
    };
    const err: AnalyzeEvent = {
      event: 'error',
      timestamp: 3000,
      message: 'should be ignored',
    };
    const fp = await writeFixture('first-terminal', [verdict, err]);
    const result = await loadAnalyzeNdjson(fp);
    expect(result?.terminal).toEqual(verdict);
    expect(result?.events).toHaveLength(2);
  });

  it('drops malformed JSON lines but keeps valid events', async () => {
    const verdict: AnalyzeEvent = {
      event: 'verdict',
      timestamp: 1000,
      verdict: {
        verdictType: 'UI_CHANGED',
        failingStatementIndex: 2,
        description: 'login button moved',
      },
    };
    const fp = await writeFixture('malformed', [
      'not-json',
      JSON.stringify(verdict),
      '{ unterminated',
    ]);
    const result = await loadAnalyzeNdjson(fp);
    expect(result?.events).toEqual([verdict]);
    expect(result?.terminal).toEqual(verdict);
  });

  it('drops lines that parse but are not AnalyzeEvent-shaped', async () => {
    const fp = await writeFixture('off-shape', [
      JSON.stringify({ foo: 'bar' }),
      JSON.stringify({ event: 'unknown', timestamp: 1 }),
      JSON.stringify({ event: 'verdict' }), // missing fields
      JSON.stringify({ event: 'error' }), // missing message
      JSON.stringify({ event: 'started', timestamp: 1000 }),
    ]);
    const result = await loadAnalyzeNdjson(fp);
    expect(result?.events).toEqual([{ event: 'started', timestamp: 1000 }]);
  });

  it('drops verdict events missing the verdictType field', async () => {
    const fp = await writeFixture('bad-verdict', [
      JSON.stringify({ event: 'verdict', timestamp: 1, verdict: {} }),
      JSON.stringify({
        event: 'verdict',
        timestamp: 2,
        verdict: { verdictType: 'BUG', failingStatementIndex: 0, description: 'x' },
      }),
    ]);
    const result = await loadAnalyzeNdjson(fp);
    expect(result?.events).toHaveLength(1);
    expect(result?.terminal?.event).toBe('verdict');
  });

  it('ignores blank lines and whitespace-only lines', async () => {
    const fp = await writeFixture('blanks', [
      '',
      '   ',
      JSON.stringify({ event: 'started', timestamp: 100 }),
      '',
      JSON.stringify({
        event: 'verdict',
        timestamp: 200,
        verdict: { verdictType: 'BUG', failingStatementIndex: 0, description: 'x' },
      }),
    ]);
    const result = await loadAnalyzeNdjson(fp);
    expect(result?.events).toHaveLength(2);
  });
});
