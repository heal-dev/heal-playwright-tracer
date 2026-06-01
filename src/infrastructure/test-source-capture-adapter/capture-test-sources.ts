/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Per-test source-capture orchestrator. Called from the fixture's
// teardown finally-block (when `config.source.enabled` is true) AFTER
// every statement has been emitted but BEFORE `projector.finalize()`
// writes `test-result` and closes the exporter.
//
// Flow:
//   1. Resolve the transitive import graph rooted at the spec file
//      (`resolveSourceGraph`).
//   2. For each resolved file, copy its raw bytes into the per-test
//      `sources/` directory under `<sourcesDir>/<relPath>`. Files
//      larger than `maxFileBytes` are NOT copied (the manifest still
//      records them, with `truncated: true`).
//   3. Emit a `test-source` record listing every file (path + size +
//      entry/truncated flags) through the exporter.
//
// Memoization: the resolved import graph for a given absolute spec
// file is cached for the lifetime of the worker process. Sibling
// tests in the same spec file, and retried attempts, reuse the graph
// instead of re-walking it. The cache is keyed by the entry file's
// real path so symlinked monorepos don't double-walk.
//
// Failure handling: every step is guarded — a parse error, a missing
// file, a write failure, anything — must not fail the test. Errors
// are logged via the supplied logger and capture continues with what
// it has. The fixture's catch-all also guards this call.

import * as fs from 'fs';
import * as path from 'path';
import type { HealTraceExporter } from '../../domain/trace-event-recorder/port/heal-trace-exporter';
import type { TestSourceFile } from '../../domain/trace-event-recorder/model/statement-trace-schema';
import type { HealTracerSourceConfig } from '../../application/heal-config';
import {
  resolveSourceGraph,
  getDefaultMaxFiles,
  getDefaultMaxFileBytes,
  type ResolvedSourceFile,
} from './resolve-source-graph';

export interface CaptureTestSourcesInput {
  /** Absolute path to the spec file. */
  entryFile: string;
  /** Absolute project root — files outside this are excluded. */
  rootDir: string;
  /** Absolute per-test sources directory. */
  sourcesDir: string;
  /** Live exporter — writes the `test-source` record once captured. */
  exporter: HealTraceExporter;
  /** User config (optional fields default per resolver). */
  config?: HealTracerSourceConfig;
  /** Optional logger seam — defaults to `console.warn`. */
  log?: (msg: string, err?: unknown) => void;
}

const graphCacheByEntry = new Map<string, ResolvedSourceFile[]>();

/** Visible for tests — clears the in-process graph cache. */
export function _clearGraphCacheForTests(): void {
  graphCacheByEntry.clear();
}

export function captureTestSources(input: CaptureTestSourcesInput): void {
  const log = input.log ?? defaultLog;
  const maxFiles = input.config?.maxFiles ?? getDefaultMaxFiles();
  const maxFileBytes = input.config?.maxFileBytes ?? getDefaultMaxFileBytes();

  let graph: ResolvedSourceFile[];
  try {
    graph = resolveOrCache(input.entryFile, input.rootDir, maxFiles);
  } catch (err) {
    log('source-capture: resolve failed', err);
    return;
  }

  if (graph.length === 0) {
    // Resolver returned nothing — entry file may have been outside
    // root, missing, or unparseable. Don't write an empty record.
    return;
  }

  const files: TestSourceFile[] = [];
  for (const node of graph) {
    let bytes: number;
    let truncated = false;
    try {
      const stat = fs.statSync(node.absPath);
      if (!stat.isFile()) continue;
      bytes = stat.size;
    } catch (err) {
      log(`source-capture: stat failed for ${node.relPath}`, err);
      continue;
    }

    if (bytes > maxFileBytes) {
      truncated = true;
    } else {
      try {
        const dst = path.join(input.sourcesDir, node.relPath);
        // Defensive: guard against a relPath that escapes sourcesDir
        // even though the resolver normalizes paths to under rootDir.
        const dstResolved = path.resolve(dst);
        const sourcesResolved = path.resolve(input.sourcesDir);
        if (
          dstResolved !== sourcesResolved &&
          !dstResolved.startsWith(sourcesResolved + path.sep)
        ) {
          log(`source-capture: skipped path escape ${node.relPath}`);
          continue;
        }
        fs.mkdirSync(path.dirname(dstResolved), { recursive: true });
        fs.copyFileSync(node.absPath, dstResolved);
      } catch (err) {
        log(`source-capture: copy failed for ${node.relPath}`, err);
        continue;
      }
    }

    const entry: TestSourceFile = {
      path: node.relPath,
      bytes,
    };
    if (node.isEntry) entry.entry = true;
    if (truncated) entry.truncated = true;
    files.push(entry);
  }

  if (files.length === 0) return;

  try {
    input.exporter.write({ kind: 'test-source', files });
  } catch (err) {
    log('source-capture: exporter write failed', err);
  }
}

function resolveOrCache(
  entryFile: string,
  rootDir: string,
  maxFiles: number,
): ResolvedSourceFile[] {
  const key = `${rootDir}::${entryFile}::${String(maxFiles)}`;
  const cached = graphCacheByEntry.get(key);
  if (cached) return cached;
  const result = resolveSourceGraph(entryFile, { rootDir, maxFiles });
  graphCacheByEntry.set(key, result);
  return result;
}

function defaultLog(msg: string, err?: unknown): void {
  if (err) {
    console.warn(`[heal-tracer] ${msg}`, err);
  } else {
    console.warn(`[heal-tracer] ${msg}`);
  }
}
