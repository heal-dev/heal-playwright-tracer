/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Opt-in per-test summary. Gated by HEAL_PRINT_ARTIFACT_PATHS=1.
// Prints the per-attempt directory — the single folder that contains
// every artefact this tracer produced for the test (the ndjson, the
// per-statement screenshots, and any Playwright artefacts the
// reporter copied in: trace.zip, video, failure screenshots).

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
    private readonly testDir: string,
    private readonly stream: SummaryOutputStream = process.stderr,
  ) {}

  print(summary: ArtifactSummary): void {
    if (process.env.HEAL_PRINT_ARTIFACT_PATHS !== '1') return;
    this.stream.write(this.formatSummary(summary));
  }

  formatSummary(summary: ArtifactSummary): string {
    return (
      `[heal-playwright-tracer] ${summary.title} (${summary.status})\n` +
      `  test artifacts dir: ${this.testDir}\n`
    );
  }
}
