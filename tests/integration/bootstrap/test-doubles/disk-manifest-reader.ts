/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Disk reader for the per-execution `execution.json` manifest the
// reporter writes on `onEnd` (see `HealTracerReporter` →
// `executionManifestPath`). Companion to `DiskTraceReader`, which reads
// the per-test `heal-traces.ndjson`; this one reads the reporter-built
// manifest that carries each attempt's `failingStatement` + `error`.
//
// A sandbox run produces exactly one execution directory, so we locate
// the single `execution.json` under `heal-traces/<executionId>/` and
// index its tests by title (the same key `DiskTraceReader` uses).

import * as fs from 'fs';
import * as path from 'path';
import type { ExecutionManifest, ExecutionTestEntry } from '../../../../src/domain/persistence';

export class DiskManifestReader {
  /** Parse the sandbox's single `execution.json`. Throws if absent. */
  read(sandboxRoot: string): ExecutionManifest {
    const healTracesRoot = path.join(sandboxRoot, 'heal-traces');
    for (const exec of fs.readdirSync(healTracesRoot, { withFileTypes: true })) {
      if (!exec.isDirectory()) continue;
      const manifestPath = path.join(healTracesRoot, exec.name, 'execution.json');
      if (fs.existsSync(manifestPath)) {
        return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ExecutionManifest;
      }
    }
    throw new Error(`No execution.json found under ${healTracesRoot}`);
  }

  /** Index the manifest's tests by title — same key as `DiskTraceReader`. */
  readByTitle(sandboxRoot: string): Map<string, ExecutionTestEntry> {
    const manifest = this.read(sandboxRoot);
    return new Map(manifest.tests.map((t) => [t.title, t]));
  }
}
