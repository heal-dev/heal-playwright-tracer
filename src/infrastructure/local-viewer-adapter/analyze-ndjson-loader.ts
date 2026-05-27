/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Reads and parses a per-test `analyze.ndjson` file written by
// `heal analyze --ndjson`. Returns the parsed event list plus the
// terminal event (verdict or error) if present.
//
// One source of truth for the on-disk schema: AnalyzeEvent (wire
// types). Garbage lines are skipped silently — the CLI is the writer
// and we don't want a single corrupt line to take down the viewer.

import { readFile } from 'node:fs/promises';

import type { AnalyzeEvent } from './local-server-api-types';

export interface AnalyzeNdjsonContent {
  /** Every parseable event, in file order. */
  events: AnalyzeEvent[];
  /**
   * The first `verdict` or `error` event encountered. Once present,
   * subsequent lines are ignored by the producer protocol.
   */
  terminal: AnalyzeEvent | null;
}

/**
 * Returns `null` when the file doesn't exist. Any other I/O error
 * propagates. Malformed JSON lines are dropped (best-effort parse).
 */
export const loadAnalyzeNdjson = async (
  ndjsonPath: string,
): Promise<AnalyzeNdjsonContent | null> => {
  let raw: string;
  try {
    raw = await readFile(ndjsonPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  const events: AnalyzeEvent[] = [];
  let terminal: AnalyzeEvent | null = null;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isAnalyzeEvent(parsed)) continue;
    events.push(parsed);
    if (terminal === null && (parsed.event === 'verdict' || parsed.event === 'error')) {
      terminal = parsed;
    }
  }

  return { events, terminal };
};

const isAnalyzeEvent = (value: unknown): value is AnalyzeEvent => {
  if (!value || typeof value !== 'object') return false;
  const v = value as { event?: unknown; timestamp?: unknown };
  if (typeof v.timestamp !== 'number') return false;
  if (v.event === 'started') return true;
  if (v.event === 'verdict') {
    const x = value as { verdict?: { verdictType?: unknown } };
    return !!x.verdict && typeof x.verdict.verdictType === 'string';
  }
  if (v.event === 'error') {
    return typeof (value as { message?: unknown }).message === 'string';
  }
  return false;
};
