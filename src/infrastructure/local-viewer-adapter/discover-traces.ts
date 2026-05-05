/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Walks a directory tree starting at `rootDir` and produces the
// per-test summary index the SPA fetches at `/api/index.json`. Looks
// recursively for any `heal-data/` directory containing
// `heal-traces.ndjson` — Playwright's `outputDir` doesn't have to be
// a direct child of `rootDir`, so this lets users run
// `heal-tracer view` from anywhere above their tests' output.
//
// Discovery stays best-effort:
//   - obvious noise (`node_modules`, `.git`, build dirs) is pruned;
//   - symlinks are not followed (avoids loops, scoped to the user's
//     own working tree);
//   - the walk caps at MAX_DIRS_WALKED to keep pathological cases
//     bounded, and warns when the cap is hit;
//   - malformed NDJSON files are skipped with a console warning
//     rather than aborting the whole index.
//
// Reads only the head and tail of each `heal-traces.ndjson` so the
// per-trace cost is O(1), not O(totalLines).

import type { Dirent } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import {
  HEAL_TRACE_SCHEMA_VERSION,
  type TestAttachment,
  type TestAttachmentsRecord,
  type TestHeader,
  type TestResultRecord,
} from '../../domain/trace-event-recorder/model/statement-trace-schema';

import { HealDataLayout } from '../heal-data-layout/heal-data-layout';

export interface DiscoveredVideo {
  /**
   * Path to the video file, relative to the test directory (the
   * parent of `heal-data/`). May contain a path separator when
   * Playwright nested the video in a per-page subdir.
   */
  file: string;
  /** Display label — the video's basename, lower-cased. */
  label: string;
}

const isVideoAttachment = (a: TestAttachment): boolean =>
  a.contentType.toLowerCase().startsWith('video/');

export interface TestSummary {
  /**
   * Stable id derived from the test directory name. Used by the
   * server to look up the NDJSON path on `/api/trace/:id` and as the
   * scoping key for `/api/screenshot/:id/...`. Sanitized — never
   * contains `..`, `/`, or `\`.
   */
  id: string;
  /** Path to the NDJSON file, relative to `rootDir`. */
  ndjsonPath: string;
  title: string;
  titlePath: string[];
  file: string;
  project: string;
  attempt: number;
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted' | 'unknown';
  duration: number;
  startedAt: number;
  /**
   * Playwright-recorded video files for this test. Sourced from the
   * NDJSON's `test-attachments` record (filtered by `video/*` MIME).
   * Empty when video isn't enabled in the user's Playwright config
   * OR when `HealTracerReporter` isn't registered.
   */
  videos: DiscoveredVideo[];
  /**
   * All Playwright attachments for this test (`trace.zip`, video,
   * failure screenshots, user attachments). Sourced from the
   * NDJSON's `test-attachments` record. Empty when the reporter
   * isn't registered.
   */
  attachments: TestAttachment[];
}

export interface ViewerIndex {
  schemaVersion: number;
  tests: TestSummary[];
}

const VIEWER_INDEX_FILENAME = '_viewer-index.json';

const isSafeId = (id: string): boolean =>
  id.length > 0 && !id.includes('..') && !id.includes('/') && !id.includes('\\');

const sanitizeId = (raw: string): string => raw.replace(/[^a-zA-Z0-9._-]+/g, '_');

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
 * test-result). Both are optional — partial traces miss test-result;
 * traces from a runner without `HealTracerReporter` registered miss
 * test-attachments. Reads the file once.
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

// Directories whose contents are never relevant — pruned during the
// walk so a user can `heal-tracer view` from a repo root without
// scanning the world. Includes the package manager dirs, common
// build outputs, and VCS metadata.
const PRUNED_DIR_NAMES = new Set<string>([
  'node_modules',
  '.git',
  '.next',
  '.cache',
  'dist',
  'coverage',
  '.turbo',
  '.vercel',
]);

const MAX_DIRS_WALKED = 5000;

interface FoundTrace {
  id: string;
  absPath: string;
  relPath: string;
}

const findHealDataDirs = async (rootDir: string): Promise<FoundTrace[]> => {
  const results: FoundTrace[] = [];
  const queue: string[] = [rootDir];
  let walked = 0;
  let warnedLimit = false;

  while (queue.length > 0) {
    if (walked >= MAX_DIRS_WALKED) {
      if (!warnedLimit) {
        console.warn(
          `[heal-tracer] walk capped at ${String(MAX_DIRS_WALKED)} directories. Pass an explicit \`dir\` argument closer to your traces if some are missing.`,
        );
        warnedLimit = true;
      }
      break;
    }
    walked += 1;
    const current = queue.shift() as string;

    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    // If this directory itself is a `heal-data` containing the
    // NDJSON, surface it and don't descend further.
    if (
      path.basename(current) === HealDataLayout.SUBDIR &&
      entries.some((e) => e.isFile() && e.name === HealDataLayout.NDJSON_FILENAME)
    ) {
      const absPath = path.join(current, HealDataLayout.NDJSON_FILENAME);
      const testDir = path.dirname(current);
      const relTestDir = path.relative(rootDir, testDir);
      const id = sanitizeId(relTestDir || path.basename(testDir));
      if (isSafeId(id)) {
        const relPath = path.relative(rootDir, absPath);
        results.push({ id, absPath, relPath });
      }
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      // Don't follow symlinks: avoids loops and keeps the walk inside
      // the user's working tree. `Dirent.isDirectory()` is false for
      // symlinks (regardless of target type) when we don't ask for
      // following — exactly what we want.
      if (PRUNED_DIR_NAMES.has(entry.name)) {
        continue;
      }
      queue.push(path.join(current, entry.name));
    }
  }

  return results;
};

const summarize = async (
  id: string,
  absPath: string,
  relPath: string,
): Promise<TestSummary | null> => {
  const header = await readHeader(absPath);
  if (!header) {
    return null;
  }
  const { result, attachments } = await readTail(absPath);

  const videos: DiscoveredVideo[] = attachments
    .filter(isVideoAttachment)
    .map((a) => ({
      file: a.path,
      label: path.basename(a.path).toLowerCase(),
    }))
    // Stable ordering: alphabetic by relative path.
    .sort((a, b) => a.file.localeCompare(b.file));

  return {
    id,
    ndjsonPath: relPath,
    title: header.title,
    titlePath: header.titlePath,
    file: header.file,
    project: header.project,
    attempt: header.context.attempt,
    status: result?.status ?? 'unknown',
    duration: result?.duration ?? 0,
    startedAt: header.startedAt,
    videos,
    attachments,
  };
};

export const discoverTraces = async (rootDir: string): Promise<TestSummary[]> => {
  const files = await findHealDataDirs(rootDir);
  const summaries: TestSummary[] = [];
  for (const { id, absPath, relPath } of files) {
    try {
      const summary = await summarize(id, absPath, relPath);
      if (summary) {
        summaries.push(summary);
      }
    } catch (err) {
      console.warn(`[heal-tracer] skipped ${relPath}:`, err);
    }
  }

  // Stable ordering: by file then attempt then title
  summaries.sort((a, b) => {
    const byFile = a.file.localeCompare(b.file);
    if (byFile !== 0) {
      return byFile;
    }
    const byAttempt = a.attempt - b.attempt;
    if (byAttempt !== 0) {
      return byAttempt;
    }

    return a.title.localeCompare(b.title);
  });

  return summaries;
};

export const buildIndex = (tests: TestSummary[]): ViewerIndex => ({
  schemaVersion: HEAL_TRACE_SCHEMA_VERSION,
  tests,
});

export const writeIndex = async (rootDir: string, tests: TestSummary[]): Promise<void> => {
  const indexPath = path.join(rootDir, VIEWER_INDEX_FILENAME);
  const data = buildIndex(tests);
  await writeFile(indexPath, JSON.stringify(data, null, 2), 'utf-8');
};

export const isSafeIdForRouting = isSafeId;
