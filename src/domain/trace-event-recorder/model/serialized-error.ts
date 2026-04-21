/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */
// Normalized error shape attached to every `throw` event emitted by
// the recorder. The service-level serializer
// (`../service/serializers/error-serializer.ts`) is what produces values of this
// shape from arbitrary thrown values; consumers of
// `../model/trace-schema` only need the type.

export interface SerializedError {
  name?: string;
  message: string;
  stack?: string;
  isPlaywrightError?: boolean;
  causes?: Array<{ name?: string; message: string; stack?: string }>;
}
