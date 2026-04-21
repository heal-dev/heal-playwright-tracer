/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
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
