/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

export interface SerializedError {
  name?: string;
  message: string;
  stack?: string;
  isPlaywrightError?: boolean;
  causes?: Array<{ name?: string; message: string; stack?: string }>;
}
