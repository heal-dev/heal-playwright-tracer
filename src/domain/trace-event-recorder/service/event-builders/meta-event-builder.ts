/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import type { TraceEventRecorderState } from '../trace-event-recorder-state';
import type { MetaEvent } from '../../model/trace-schema';

export function buildMetaEvent(state: TraceEventRecorderState): void {
  const event: MetaEvent = {
    ...state.staticContext,
    ...(state.dynamicContext ?? {}),
    type: 'meta',
    seq: ++state.seq,
    t: 0,
    wallTime: state.clock.wallNow(),
  };
  state.exporter.write(event);
}
