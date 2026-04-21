/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */

import type { TraceEvent } from '../model/trace-schema';

export type { TraceEvent };

export interface TraceEventConsumer {
  write(event: TraceEvent): void;
  clear(): void;
}
