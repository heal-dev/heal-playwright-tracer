/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// In-process HTTP collector for the integration suite.
//
// Bound to `127.0.0.1:0` so the OS picks a free port; the resolved
// URL is handed to the sandbox via `STUB_COLLECTOR_URL` so the user
// exporter (configured via `configureTracer`) can POST to it.
//
// The sandbox sends one POST per test on `close()`: the request body
// is the test's full ndjson stream. We keep each batch as a separate
// `RawBatch` rather than concatenating, because batch boundaries map
// 1:1 to tests — `HttpTraceReader` walks them straight into
// `Map<title, ParsedTrace>` without needing to demux by `runId`.

import * as http from 'http';
import type { AddressInfo } from 'net';
import type { HealTraceRecord } from '../../../../src/domain/trace-event-recorder/model/statement-trace-schema';

export interface RawBatch {
  /** Records from a single test's `close()` POST, in emission order. */
  records: HealTraceRecord[];
}

export class StubCollectorServer {
  private server: http.Server | null = null;
  private readonly batches: RawBatch[] = [];
  private url: string | null = null;

  async start(): Promise<{ url: string }> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405).end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            const records = body
              .split('\n')
              .filter((line) => line.length > 0)
              .map((line) => JSON.parse(line) as HealTraceRecord);
            this.batches.push({ records });
            res.writeHead(200).end();
          } catch (err) {
            // Surface the parse failure so beforeAll fails loudly,
            // not silently. Returning 500 makes the exporter's
            // close() reject and the test run trips on it.
            console.error('[stub-collector] failed to parse POST body:', err);
            res.writeHead(500).end();
          }
        });
        req.on('error', reject);
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        this.server = server;
        this.url = `http://127.0.0.1:${port}`;
        resolve({ url: this.url });
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Snapshot of every batch received so far, in arrival order. */
  received(): readonly RawBatch[] {
    return this.batches;
  }

  getUrl(): string {
    if (!this.url) throw new Error('StubCollectorServer: call start() first.');
    return this.url;
  }
}
