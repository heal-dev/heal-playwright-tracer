/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Opt-in per-test summary. Gated by HEAL_PRINT_ARTIFACT_PATHS=1.
// Prints the test's output directory — the single folder that
// contains every artifact Playwright and this tracer produce for
// the test (trace.zip, videos, and the nested `heal-data/` with
// the ndjson + highlight screenshots).

import { HealDataLayout } from '../heal-data-layout';

export type ArtifactSummaryStatus = 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';

export interface ArtifactSummary {
  title: string;
  status: ArtifactSummaryStatus;
}

export interface SummaryOutputStream {
  write(chunk: string): boolean;
}

export class ArtifactSummaryPrinter {
  constructor(
    private readonly layout: HealDataLayout,
    private readonly stream: SummaryOutputStream = process.stderr,
  ) {}

  print(summary: ArtifactSummary): void {
    if (process.env.HEAL_PRINT_ARTIFACT_PATHS !== '1') return;
    this.stream.write(this.formatSummary(summary));
  }

  formatSummary(summary: ArtifactSummary): string {
    return (
      `[heal-playwright-tracer] ${summary.title} (${summary.status})\n` +
      `  test artifacts dir: ${this.layout.outputDir}\n`
    );
  }
}
