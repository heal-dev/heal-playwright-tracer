/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import type { HealTraceRecord } from '../model/statement-trace-schema';

export type { HealTraceRecord };

export interface HealTraceExporter {
  write(record: HealTraceRecord): void;
  close(): Promise<void>;
}
