/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'child_process';
import { SystemInfoAdapter } from '../../../src/infrastructure/system-info-adapter';

const execMock = execSync as unknown as ReturnType<typeof vi.fn>;

describe('SystemInfoAdapter', () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  afterEach(() => {
    delete process.env.CI;
  });

  it('captures pid/nodeVersion/platform/arch/hostname/cwd on construction', () => {
    execMock.mockReturnValueOnce(Buffer.from('deadbeef\n'));
    const info = new SystemInfoAdapter().getStaticContext();

    expect(info.pid).toBe(process.pid);
    expect(info.nodeVersion).toBe(process.versions.node);
    expect(info.platform).toBe(process.platform);
    expect(info.arch).toBe(process.arch);
    expect(typeof info.hostname).toBe('string');
    expect(info.cwd).toBe(process.cwd());
    expect(info.gitSha).toBe('deadbeef');
  });

  it('sets isCI from process.env.CI', () => {
    execMock.mockReturnValue(Buffer.from(''));
    process.env.CI = '1';
    expect(new SystemInfoAdapter().getStaticContext().isCI).toBe(true);
    delete process.env.CI;
    expect(new SystemInfoAdapter().getStaticContext().isCI).toBe(false);
  });

  it('returns gitSha=undefined when git rev-parse throws', () => {
    execMock.mockImplementationOnce(() => {
      throw new Error('not a git repo');
    });
    const info = new SystemInfoAdapter().getStaticContext();
    expect(info.gitSha).toBeUndefined();
  });

  it('reads git sha only once per instance (captured eagerly)', () => {
    execMock.mockReturnValueOnce(Buffer.from('abc123\n'));
    const adapter = new SystemInfoAdapter();
    adapter.getStaticContext();
    adapter.getStaticContext();
    adapter.getStaticContext();
    expect(execMock).toHaveBeenCalledTimes(1);
  });
});
