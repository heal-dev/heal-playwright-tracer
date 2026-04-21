/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 *
 */

// SystemInfoProvider — port for the per-process static context the
// recorder stamps onto every `meta` event.
//
// Separate from `Clock` because these values change at most once per
// process (usually at module load) while the clock is read on every
// event. Adapters in infrastructure/ read git/os/process state and
// implement this contract. Tests pass a deterministic stub.

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
