/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Single source of truth for the on-disk layout the tracer produces
// under each test's `testInfo.outputDir`. Both the fixture (writer)
// and the artifact summary printer (reader) depend on this class so
// the subdir name and ndjson filename live in exactly one place.

import * as path from 'path';

export class HealDataLayout {
  static readonly SUBDIR = 'heal-data';
  static readonly NDJSON_FILENAME = 'heal-traces.ndjson';

  constructor(readonly outputDir: string) {}

  get healDataDir(): string {
    return path.join(this.outputDir, HealDataLayout.SUBDIR);
  }

  get ndjsonPath(): string {
    return path.join(this.healDataDir, HealDataLayout.NDJSON_FILENAME);
  }
}
