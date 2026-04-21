/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */

import type { HealTraceRecord } from '../model/statement-trace-schema';

export type { HealTraceRecord };

export interface HealTraceExporter {
  write(record: HealTraceRecord): void;
  close(): Promise<void>;
}
