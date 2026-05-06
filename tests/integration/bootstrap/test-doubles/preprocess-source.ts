/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Source for the preprocessor file written into the sandbox by
// `IntegrationSandbox.scaffold({ withPreProcessor: true })`.
//
// Why a string literal: same reason as `stub-exporter-source.ts` —
// the file lives inside the sandbox tmp dir so the sandbox's
// `playwright.config.ts` can `import` it relatively. We can't
// reference a path under our repo because the sandbox runs
// `npm install` against its own node_modules and doesn't see our
// source tree.
//
// What it provides: a single `StatementPreProcessor` function that
// scans every statement's `meta.source` for `marker:<word>` patterns,
// and on a hit appends one JSON line to
// `<ctx.healDataDir>/preprocess-record.ndjson`. The integration test
// reads that file back to assert the fixture wired the global
// correctly and the meta payload arrived intact.

export const PREPROCESS_SOURCE = `import * as fs from 'fs';
import * as path from 'path';
import type { StatementPreProcessor } from '@heal-dev/heal-playwright-tracer';

const MARKER = /marker:(\\w+)/;

export const recordingPreProcessor: StatementPreProcessor = ({ meta, ctx }) => {
  const m = MARKER.exec(meta.source);
  if (!m) return;
  // Sanity-check that the runtime context exposes the live
  // BrowserContext per the public StatementPreProcessorContext shape.
  // Throwing here would propagate out as a __heal_throw on the
  // statement, and the test would catch it via the trace's status.
  if (!ctx.browserContext) {
    throw new Error('preprocessor: ctx.browserContext is missing');
  }
  const out = path.join(ctx.healDataDir, 'preprocess-record.ndjson');
  fs.appendFileSync(
    out,
    JSON.stringify({
      marker: m[1],
      file: meta.file,
      startLine: meta.startLine,
      kind: meta.kind,
      source: meta.source,
    }) + '\\n',
    'utf8',
  );
};
`;
