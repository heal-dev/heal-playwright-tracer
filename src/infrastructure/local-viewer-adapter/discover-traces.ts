/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Discovers executions and per-test traces from the persistent
// `heal-traces/` tree:
//
//   <rootDir>/heal-traces/
//   ├── executions.ndjson
//   └── <executionId>/
//       ├── execution.json
//       └── <playwrightTestId>/
//           └── <attempt>/
//               ├── heal-traces.ndjson
//               ├── trace.zip
//               ├── screenshots/
//               └── videos/
//
// Two entry points:
//   - `discoverExecutions(rootDir)` — list known executions for the
//     header dropdown. Reads `executions.ndjson` first; falls back to
//     a directory scan if the index file is missing or partial.
//   - `discoverTraces(rootDir, executionId)` — list per-attempt
//     summaries inside one execution.
//
// Each summary's `id` is `${playwrightTestId}_${attempt}` — a
// compound routing key the local-viewer URL splits back into the
// two path segments the disk layout expects. Keeps the URL one
// segment shorter than the disk shape while preserving uniqueness.

import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';

import {
  HEAL_TRACE_SCHEMA_VERSION,
  type TestAttachment,
  type TestAttachmentsRecord,
  type TestHeader,
  type TestResultRecord,
} from '../../domain/trace-event-recorder/model/statement-trace-schema';
import { HealTracesLayout } from '../heal-traces-layout';
import type { ExecutionManifest, ExecutionRecord, TestStatus } from '../../domain/persistence';

export interface ExecutionSummary {
  executionId: string;
  source?: 'env' | 'generated';
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  totals?: ExecutionRecord['totals'];
  git?: ExecutionRecord['git'];
  playwrightVersion?: string;
}

export interface TestSummary {
  /**
   * Compound routing key for `/api/.../tests/:playwrightTestId/:attempt`.
   * Format: `${playwrightTestId}_${attempt}` — the SPA splits on the
   * last underscore. Sanitized — never contains `..`, `/`, or `\`.
   */
  id: string;
  /** Underlying Playwright `testInfo.testId`. */
  playwrightTestId: string;
  /** 1-indexed attempt number. */
  attempt: number;
  /** NDJSON path relative to `<rootDir>/heal-traces/<executionId>/`. */
  ndjsonPath: string;
  title: string;
  titlePath: string[];
  file: string;
  project: string;
  status: TestStatus;
  duration: number;
  startedAt: number;
  /**
   * All Playwright attachments for this test. Sourced from the
   * NDJSON's `test-attachments` record. Empty when the reporter
   * isn't registered. Videos are NOT separately exposed — consumers
   * filter on `contentType.startsWith('video/')` to derive them.
   */
  attachments: TestAttachment[];
}

export interface ViewerIndex {
  schemaVersion: number;
  executionId: string;
  tests: TestSummary[];
}

const isSafeId = (id: string): boolean =>
  id.length > 0 && !id.includes('..') && !id.includes('/') && !id.includes('\\');

const parseLine = <T>(line: string): T | null => {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
};

const readHeader = async (ndjsonPath: string): Promise<TestHeader | null> => {
  const content = await readFile(ndjsonPath, 'utf-8');
  const firstLine = content.split('\n').find((l) => l.trim().length > 0);
  if (!firstLine) {
    return null;
  }
  const parsed = parseLine<{ kind: string; test: TestHeader }>(firstLine);
  if (!parsed || parsed.kind !== 'test-header') {
    return null;
  }

  return parsed.test;
};

/**
 * Read the tail of the NDJSON to extract the test-result and the
 * test-attachments record (which the reporter appends after
 * test-result). Both are optional. Reads the file once.
 */
const readTail = async (
  ndjsonPath: string,
): Promise<{
  result: TestResultRecord | null;
  attachments: TestAttachment[];
}> => {
  const content = await readFile(ndjsonPath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);

  let result: TestResultRecord | null = null;
  let attachments: TestAttachment[] = [];

  for (let i = lines.length - 1; i >= 0 && (!result || attachments.length === 0); i -= 1) {
    const parsed = parseLine<{ kind: string }>(lines[i]);
    if (!parsed) continue;
    if (!result && parsed.kind === 'test-result') {
      result = parsed as unknown as TestResultRecord;
    } else if (attachments.length === 0 && parsed.kind === 'test-attachments') {
      attachments = (parsed as unknown as TestAttachmentsRecord).attachments;
    }
  }

  return { result, attachments };
};

const buildSummaryId = (playwrightTestId: string, attempt: number): string =>
  `${playwrightTestId}_${attempt}`;

/**
 * Decode the compound id back into (playwrightTestId, attempt). Splits
 * on the LAST underscore so test ids that themselves contain underscores
 * round-trip correctly. Returns null on invalid shapes.
 */
export const parseSummaryId = (
  id: string,
): { playwrightTestId: string; attempt: number } | null => {
  if (!isSafeId(id)) return null;
  const lastUnderscore = id.lastIndexOf('_');
  if (lastUnderscore <= 0 || lastUnderscore >= id.length - 1) return null;
  const tid = id.slice(0, lastUnderscore);
  const attemptStr = id.slice(lastUnderscore + 1);
  if (!/^\d+$/.test(attemptStr)) return null;
  const attempt = Number.parseInt(attemptStr, 10);
  if (attempt <= 0) return null;
  return { playwrightTestId: tid, attempt };
};

interface FoundAttempt {
  playwrightTestId: string;
  attempt: number;
  ndjsonPathAbs: string;
  ndjsonPathRel: string;
}

const safeReaddir = async (dir: string): Promise<Dirent[]> => {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

const findAttempts = async (executionDir: string): Promise<FoundAttempt[]> => {
  const out: FoundAttempt[] = [];
  const testEntries = await safeReaddir(executionDir);
  for (const testEntry of testEntries) {
    if (!testEntry.isDirectory()) continue;
    const playwrightTestId = testEntry.name;
    const testDir = path.join(executionDir, playwrightTestId);
    const attemptEntries = await safeReaddir(testDir);
    for (const attemptEntry of attemptEntries) {
      if (!attemptEntry.isDirectory()) continue;
      if (!/^\d+$/.test(attemptEntry.name)) continue;
      const attempt = Number.parseInt(attemptEntry.name, 10);
      if (attempt <= 0) continue;
      const ndjsonPathAbs = path.join(testDir, attemptEntry.name, HealTracesLayout.NDJSON_FILENAME);
      try {
        await stat(ndjsonPathAbs);
      } catch {
        continue;
      }
      const ndjsonPathRel = path.relative(executionDir, ndjsonPathAbs);
      out.push({ playwrightTestId, attempt, ndjsonPathAbs, ndjsonPathRel });
    }
  }
  return out;
};

const summarize = async (found: FoundAttempt): Promise<TestSummary | null> => {
  const header = await readHeader(found.ndjsonPathAbs);
  if (!header) {
    return null;
  }
  const { result, attachments } = await readTail(found.ndjsonPathAbs);

  return {
    id: buildSummaryId(found.playwrightTestId, found.attempt),
    playwrightTestId: found.playwrightTestId,
    attempt: found.attempt,
    ndjsonPath: found.ndjsonPathRel,
    title: header.title,
    titlePath: header.titlePath,
    file: header.file,
    project: header.project,
    status: result?.status ?? 'unknown',
    duration: result?.duration ?? 0,
    startedAt: header.startedAt,
    attachments,
  };
};

export const discoverTraces = async (
  rootDir: string,
  executionId: string,
): Promise<TestSummary[]> => {
  const layout = new HealTracesLayout(rootDir, executionId);
  const executionDir = layout.executionDir();
  const found = await findAttempts(executionDir);
  const summaries: TestSummary[] = [];
  for (const f of found) {
    try {
      const s = await summarize(f);
      if (s) summaries.push(s);
    } catch (err) {
      console.warn(`[heal-tracer] skipped ${f.ndjsonPathRel}:`, err);
    }
  }
  summaries.sort((a, b) => {
    const byFile = a.file.localeCompare(b.file);
    if (byFile !== 0) return byFile;
    const byAttempt = a.attempt - b.attempt;
    if (byAttempt !== 0) return byAttempt;
    return a.title.localeCompare(b.title);
  });
  return summaries;
};

export const buildIndex = (executionId: string, tests: TestSummary[]): ViewerIndex => ({
  schemaVersion: HEAL_TRACE_SCHEMA_VERSION,
  executionId,
  tests,
});

/**
 * List executions known under `<rootDir>/heal-traces/`. Tries to read
 * `executions.ndjson` first; if absent or partial, falls back to
 * scanning subdirectory names. The index file lists records in the
 * order runs were appended; we surface them newest-first to match
 * the typical viewer use ("show me the latest run").
 */
export const discoverExecutions = async (rootDir: string): Promise<ExecutionSummary[]> => {
  const tracesRoot = path.join(rootDir, HealTracesLayout.DIRNAME);
  const indexed = await readExecutionsIndex(tracesRoot);
  const indexedIds = new Set(indexed.map((e) => e.executionId));

  // Backfill: any execution dir on disk that the index file doesn't
  // mention (interrupted runs that didn't reach onEnd, or runs from
  // before the reporter started writing the index).
  const dirEntries = await safeReaddir(tracesRoot);
  for (const entry of dirEntries) {
    if (!entry.isDirectory()) continue;
    if (indexedIds.has(entry.name)) continue;
    if (!isSafeId(entry.name)) continue;
    const manifestPath = path.join(tracesRoot, entry.name, HealTracesLayout.EXECUTION_MANIFEST);
    try {
      const body = await readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(body) as ExecutionManifest;
      indexed.push({
        executionId: manifest.executionId,
        source: manifest.source,
        startedAt: manifest.startedAt,
        endedAt: manifest.endedAt,
        durationMs: manifest.durationMs,
        totals: manifest.totals,
        git: manifest.git,
        playwrightVersion: manifest.playwrightVersion,
      });
    } catch {
      indexed.push({ executionId: entry.name });
    }
  }

  indexed.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return indexed;
};

const readExecutionsIndex = async (tracesRoot: string): Promise<ExecutionSummary[]> => {
  const indexPath = path.join(tracesRoot, HealTracesLayout.EXECUTIONS_NDJSON);
  let body: string;
  try {
    body = await readFile(indexPath, 'utf-8');
  } catch {
    return [];
  }
  const out: ExecutionSummary[] = [];
  for (const line of body.split('\n')) {
    if (line.trim().length === 0) continue;
    const parsed = parseLine<ExecutionRecord>(line);
    if (!parsed || parsed.kind !== 'execution') continue;
    if (!isSafeId(parsed.executionId)) continue;
    out.push({
      executionId: parsed.executionId,
      source: parsed.source,
      startedAt: parsed.startedAt,
      endedAt: parsed.endedAt,
      durationMs: parsed.durationMs,
      totals: parsed.totals,
      git: parsed.git,
      playwrightVersion: parsed.playwrightVersion,
    });
  }
  return out;
};

export const isSafeIdForRouting = isSafeId;
