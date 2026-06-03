/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { Page } from 'playwright';
import {
  ensurePageNavigationPatched,
  setActivePageStamper,
} from '../../../src/infrastructure/playwright-page-registry-adapter';

// Each test builds a FRESH prototype object so the process-global
// idempotency Symbol on the prototype never leaks across cases.
function makePageOnFreshProto(impl: Record<string, (...a: unknown[]) => unknown>): {
  page: Page;
  proto: Record<string, unknown>;
} {
  const proto = { ...impl } as Record<string, unknown>;
  const page = Object.create(proto) as Page;
  return { page, proto };
}

afterEach(() => setActivePageStamper(null));

describe('ensurePageNavigationPatched', () => {
  it('stamps the page AFTER the original navigation resolves', async () => {
    const order: string[] = [];
    const { page } = makePageOnFreshProto({
      goto: async () => {
        order.push('orig');
        return 'response';
      },
    });
    ensurePageNavigationPatched(page);
    setActivePageStamper((p) => {
      order.push('stamp');
      expect(p).toBe(page);
    });

    const result = await (page as unknown as { goto: () => Promise<unknown> }).goto();
    expect(result).toBe('response'); // return value preserved
    expect(order).toEqual(['orig', 'stamp']); // stamp after navigation
  });

  it('still stamps when the navigation throws (finally)', async () => {
    let stamped = false;
    const { page } = makePageOnFreshProto({
      goto: async () => {
        throw new Error('nav failed');
      },
    });
    ensurePageNavigationPatched(page);
    setActivePageStamper(() => {
      stamped = true;
    });

    await expect((page as unknown as { goto: () => Promise<unknown> }).goto()).rejects.toThrow(
      'nav failed',
    );
    expect(stamped).toBe(true);
  });

  it('does not let a throwing stamper mask the navigation result', async () => {
    const { page } = makePageOnFreshProto({
      reload: async () => 'ok',
    });
    ensurePageNavigationPatched(page);
    setActivePageStamper(() => {
      throw new Error('stamp boom');
    });

    const result = await (page as unknown as { reload: () => Promise<unknown> }).reload();
    expect(result).toBe('ok');
  });

  it('is idempotent — patching the same prototype twice keeps one wrapper', async () => {
    let calls = 0;
    const { page, proto } = makePageOnFreshProto({
      goto: async () => {
        calls++;
      },
    });
    ensurePageNavigationPatched(page);
    const firstWrapper = proto.goto;
    ensurePageNavigationPatched(page);
    expect(proto.goto).toBe(firstWrapper); // not re-wrapped

    setActivePageStamper(() => {});
    await (page as unknown as { goto: () => Promise<unknown> }).goto();
    expect(calls).toBe(1); // original invoked exactly once
  });

  it('is a no-op when no stamper is active', async () => {
    const { page } = makePageOnFreshProto({ goto: async () => 'r' });
    ensurePageNavigationPatched(page);
    setActivePageStamper(null);
    await expect((page as unknown as { goto: () => Promise<unknown> }).goto()).resolves.toBe('r');
  });
});
