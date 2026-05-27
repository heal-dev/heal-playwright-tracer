/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Single source of truth for the persistent on-disk layout the tracer
// produces under `<rootDir>/heal-traces/`:
//
//   <rootDir>/heal-traces/<executionId>/<playwrightTestId>/<attempt>/heal-traces.ndjson
//   <rootDir>/heal-traces/<executionId>/<playwrightTestId>/<attempt>/trace.zip
//   <rootDir>/heal-traces/<executionId>/<playwrightTestId>/<attempt>/screenshots/<file>
//   <rootDir>/heal-traces/<executionId>/<playwrightTestId>/<attempt>/videos/<file>
//
// Pure path joins — no I/O, no fs.existsSync, no validation beyond
// traversal-safety on user-supplied relative paths.

import * as path from 'path';

import { ANALYZE_NDJSON_FILENAME } from '../local-viewer-adapter/local-server-api-types';

export class HealTracesLayout {
  static readonly DIRNAME = 'heal-traces';
  static readonly NDJSON_FILENAME = 'heal-traces.ndjson';
  static readonly NETWORK_NDJSON_FILENAME = 'heal-network.ndjson';
  static readonly CONSOLE_NDJSON_FILENAME = 'heal-console.ndjson';
  static readonly TRACE_FILENAME = 'trace.zip';
  static readonly SCREENSHOTS_SUBDIR = 'screenshots';
  static readonly VIDEOS_SUBDIR = 'videos';
  static readonly EXECUTIONS_NDJSON = 'executions.ndjson';
  static readonly EXECUTION_MANIFEST = 'execution.json';
  static readonly ANALYZE_NDJSON_FILENAME = ANALYZE_NDJSON_FILENAME;

  constructor(
    readonly rootDir: string,
    readonly executionId: string,
  ) {}

  healTracesRoot(): string {
    return path.join(this.rootDir, HealTracesLayout.DIRNAME);
  }

  executionDir(): string {
    return path.join(this.healTracesRoot(), this.executionId);
  }

  testDir(playwrightTestId: string, attempt: number): string {
    return path.join(this.executionDir(), playwrightTestId, String(attempt));
  }

  ndjsonPath(playwrightTestId: string, attempt: number): string {
    return path.join(this.testDir(playwrightTestId, attempt), HealTracesLayout.NDJSON_FILENAME);
  }

  analyzeNdjsonPath(playwrightTestId: string, attempt: number): string {
    return path.join(
      this.testDir(playwrightTestId, attempt),
      HealTracesLayout.ANALYZE_NDJSON_FILENAME,
    );
  }

  networkNdjsonPath(playwrightTestId: string, attempt: number): string {
    return path.join(
      this.testDir(playwrightTestId, attempt),
      HealTracesLayout.NETWORK_NDJSON_FILENAME,
    );
  }

  consoleNdjsonPath(playwrightTestId: string, attempt: number): string {
    return path.join(
      this.testDir(playwrightTestId, attempt),
      HealTracesLayout.CONSOLE_NDJSON_FILENAME,
    );
  }

  tracePath(playwrightTestId: string, attempt: number): string {
    return path.join(this.testDir(playwrightTestId, attempt), HealTracesLayout.TRACE_FILENAME);
  }

  screenshotPath(playwrightTestId: string, attempt: number, filename: string): string {
    return path.join(
      this.testDir(playwrightTestId, attempt),
      HealTracesLayout.SCREENSHOTS_SUBDIR,
      path.basename(filename),
    );
  }

  videoPath(playwrightTestId: string, attempt: number, filename: string): string {
    return path.join(
      this.testDir(playwrightTestId, attempt),
      HealTracesLayout.VIDEOS_SUBDIR,
      path.basename(filename),
    );
  }

  /**
   * Resolve a free-form relative path under the per-attempt directory
   * (used for user attachments where preserving subdirs matters).
   * Throws if `relPath` resolves outside the per-attempt root —
   * guarding against path-traversal in attachment paths.
   */
  attachmentPath(playwrightTestId: string, attempt: number, relPath: string): string {
    const root = this.testDir(playwrightTestId, attempt);
    const resolved = path.resolve(root, relPath);
    const rootResolved = path.resolve(root);
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
      throw new Error(`attachment path escapes test directory: ${relPath}`);
    }

    return resolved;
  }

  executionsNdjsonPath(): string {
    return path.join(this.healTracesRoot(), HealTracesLayout.EXECUTIONS_NDJSON);
  }

  executionManifestPath(): string {
    return path.join(this.executionDir(), HealTracesLayout.EXECUTION_MANIFEST);
  }
}
