/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import type { TraceEvent } from '../model/trace-schema';

export type { TraceEvent };

export interface TraceEventConsumer {
  write(event: TraceEvent): void;
  clear(): void;
}
