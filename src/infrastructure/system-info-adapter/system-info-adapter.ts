/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import * as os from 'os';
import { execSync } from 'child_process';
import type {
  SystemInfo,
  SystemInfoProvider,
} from '../../domain/trace-event-recorder/port/system-info-provider';

export class SystemInfoAdapter implements SystemInfoProvider {
  private readonly info: SystemInfo;

  constructor() {
    this.info = {
      pid: process.pid,
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      isCI: !!process.env.CI,
      cwd: process.cwd(),
      gitSha: SystemInfoAdapter.readGitSha(),
    };
  }

  getStaticContext(): SystemInfo {
    return this.info;
  }

  private static readGitSha(): string | undefined {
    try {
      return execSync('git rev-parse HEAD', {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
    } catch (_) {
      return undefined;
    }
  }
}
