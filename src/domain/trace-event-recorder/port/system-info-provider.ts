/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */

export interface SystemInfo {
  pid: number;
  nodeVersion: string;
  platform: string;
  arch: string;
  hostname: string;
  isCI: boolean;
  cwd: string;
  gitSha?: string;
}

export interface SystemInfoProvider {
  getStaticContext(): SystemInfo;
}
