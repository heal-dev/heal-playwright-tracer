/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 *
 */

export { TraceEventRecorder, SCHEMA_VERSION } from './trace-event-recorder';
export type { CreateTraceEventRecorderOptions, Clock, EnterMeta } from './trace-event-recorder';
export { ActiveEnterStack } from './active-enter-stack';
export { CompositeHealTraceExporter } from './exporters/composite-heal-trace-exporter';
export type { TraceEventRecorderState } from './trace-event-recorder-state';
