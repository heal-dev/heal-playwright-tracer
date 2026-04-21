/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */

export interface SerializedError {
  name?: string;
  message: string;
  stack?: string;
  isPlaywrightError?: boolean;
  causes?: Array<{ name?: string; message: string; stack?: string }>;
}
