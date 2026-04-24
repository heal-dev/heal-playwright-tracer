/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Source for the stub-exporter file written into the sandbox by
// `IntegrationSandbox.scaffold({ withStubExporter: true })`.
//
// Why a string literal: the file lives INSIDE the sandbox tmp dir so
// the sandbox's `playwright.config.ts` can `import` it relatively. We
// can't reference a path under our repo because the sandbox runs `npm
// install` against its own node_modules and doesn't see our source
// tree.
//
// What it provides: a `HealTraceExporterFactory` that buffers every
// `HealTraceRecord` written during a test, then on `close()` POSTs
// the full ndjson body to `STUB_COLLECTOR_URL`. One POST per test —
// the per-test factory call gives each test its own buffer.
//
// Production-shape: this is exactly the kind of exporter a real user
// would write to ship traces to their backend, plugged in via the
// public `configureTracer({ exporters: [stubExporterFactory] })` API.

export const STUB_EXPORTER_SOURCE = `import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import type {
  HealTraceExporter,
  HealTraceExporterFactory,
  HealTraceRecord,
  HealTracerTestContext,
} from '@heal-dev/heal-playwright-tracer';

export const stubExporterFactory: HealTraceExporterFactory = (
  ctx: HealTracerTestContext,
): HealTraceExporter => {
  const records: unknown[] = [];
  // Captured at factory time so the collector can assert the tracer
  // surfaces the authoritative ndjson path through the public context.
  const healTracesFilePath = ctx.transport.healTracesFilePath;
  return {
    write(record: HealTraceRecord): void {
      records.push(record);
    },
    async close(): Promise<void> {
      const url = process.env.STUB_COLLECTOR_URL;
      if (!url) return;
      const body = JSON.stringify({ healTracesFilePath, records });
      records.length = 0;
      const target = new URL(url);
      const lib = target.protocol === 'https:' ? https : http;
      await new Promise<void>((resolve, reject) => {
        const req = lib.request(
          {
            method: 'POST',
            hostname: target.hostname,
            port: target.port,
            path: target.pathname + target.search,
            headers: {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(body).toString(),
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => {
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve();
              else reject(new Error('stub-collector POST failed: ' + res.statusCode));
            });
          },
        );
        req.on('error', reject);
        req.write(body);
        req.end();
      });
    },
  };
};
`;
