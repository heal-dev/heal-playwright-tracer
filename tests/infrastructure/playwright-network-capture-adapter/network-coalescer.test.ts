/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect } from 'vitest';
import type { Request as PwRequest } from 'playwright';
import {
  NetworkCoalescer,
  type PendingRecord,
} from '../../../src/infrastructure/playwright-network-capture-adapter/network-coalescer';

function fakeRequest(): PwRequest {
  return {} as unknown as PwRequest;
}

function seed(req: PwRequest, requestId: string): PendingRecord {
  return {
    kind: 'network',
    t: 0,
    requestId,
    source: 'browser-context',
    method: 'GET',
    url: 'https://example.test/',
    requestHeaders: {},
    __request: req,
  };
}

describe('NetworkCoalescer', () => {
  it('assigns a stable id per Request instance', () => {
    const c = new NetworkCoalescer();
    const r1 = fakeRequest();
    const r2 = fakeRequest();
    expect(c.idFor(r1)).toBe('req-1');
    expect(c.idFor(r1)).toBe('req-1');
    expect(c.idFor(r2)).toBe('req-2');
  });

  it('begin/update/finalize merges patches into one record', () => {
    const c = new NetworkCoalescer();
    const r = fakeRequest();
    const id = c.idFor(r);
    c.begin(seed(r, id));
    c.update(id, { status: 200, statusText: 'OK' });
    c.update(id, { responseHeaders: { 'content-type': 'application/json' } });
    const finalized = c.finalize(id);
    expect(finalized).toMatchObject({
      requestId: id,
      method: 'GET',
      status: 200,
      statusText: 'OK',
      responseHeaders: { 'content-type': 'application/json' },
    });
    // The internal Playwright Request should not leak into the public schema.
    expect(finalized).not.toHaveProperty('__request');
  });

  it('finalize is idempotent — second call returns undefined', () => {
    const c = new NetworkCoalescer();
    const r = fakeRequest();
    const id = c.idFor(r);
    c.begin(seed(r, id));
    expect(c.finalize(id)).toBeDefined();
    expect(c.finalize(id)).toBeUndefined();
  });

  it('update silently ignores unknown ids (request was filtered out)', () => {
    const c = new NetworkCoalescer();
    expect(() => c.update('req-unknown', { status: 200 })).not.toThrow();
  });

  it('drain emits every still-pending record and empties the map', () => {
    const c = new NetworkCoalescer();
    const r1 = fakeRequest();
    const r2 = fakeRequest();
    c.begin(seed(r1, c.idFor(r1)));
    c.begin(seed(r2, c.idFor(r2)));
    expect(c.size()).toBe(2);
    const drained = c.drain();
    expect(drained).toHaveLength(2);
    expect(c.size()).toBe(0);
  });

  it('has() reflects whether a Request has been seen', () => {
    const c = new NetworkCoalescer();
    const r = fakeRequest();
    expect(c.has(r)).toBe(false);
    c.idFor(r);
    expect(c.has(r)).toBe(true);
  });
});
