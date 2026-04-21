/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

export const STUB_EXPORTER_SOURCE = `import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import type {
  HealTraceExporter,
  HealTraceExporterFactory,
  HealTraceRecord,
} from '@heal-dev/heal-playwright-tracer';

export const stubExporterFactory: HealTraceExporterFactory = (): HealTraceExporter => {
  const buffer: string[] = [];
  return {
    write(record: HealTraceRecord): void {
      buffer.push(JSON.stringify(record));
    },
    async close(): Promise<void> {
      const url = process.env.STUB_COLLECTOR_URL;
      if (!url) return;
      const body = buffer.join('\\n') + '\\n';
      buffer.length = 0;
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
              'content-type': 'application/x-ndjson',
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
