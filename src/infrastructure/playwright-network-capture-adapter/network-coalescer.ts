/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// NetworkCoalescer — merges Playwright's split request lifecycle
// (`request` → `response` → `requestfinished` | `requestfailed`)
// into a single `NetworkRecord` per HTTP exchange.
//
// Why a separate class: keeping this pure (no fs, no Playwright
// listeners, no clock — every input is passed in by the session)
// makes it cheap to unit-test the lifecycle edge cases (redirect
// chains, request that never gets a response, response without a
// finished event, …) without standing up a browser.
//
// Stable id strategy: Playwright does NOT expose a request id, but
// the `Request` instance is the same object across `request`,
// `response`, `requestfinished`, and `requestfailed` events. We
// therefore key on object identity via a `WeakMap<Request, string>`
// and synthesize a per-test counter id (`req-1`, `req-2`, …) the
// first time we see a request. This survives popups, redirects, and
// the api-request-context.

import type { Request as PwRequest } from 'playwright';
import type {
  NetworkRecord,
  NetworkSource,
} from '../../domain/trace-event-recorder/model/network-trace-schema';

export interface PendingRecord extends NetworkRecord {
  /** Internal — the Playwright Request the coalescer keyed on. */
  __request: PwRequest;
}

export class NetworkCoalescer {
  private readonly idsByRequest = new WeakMap<PwRequest, string>();
  private readonly pending = new Map<string, PendingRecord>();
  private nextId = 1;

  /** Test-only escape hatch. */
  size(): number {
    return this.pending.size;
  }

  has(request: PwRequest): boolean {
    return this.idsByRequest.has(request);
  }

  /**
   * Resolve (and assign on first use) the per-test id we attribute
   * to this request. Stable across every event Playwright fires for
   * the same Request instance.
   */
  idFor(request: PwRequest): string {
    let id = this.idsByRequest.get(request);
    if (id === undefined) {
      id = `req-${this.nextId++}`;
      this.idsByRequest.set(request, id);
    }
    return id;
  }

  /**
   * Register a new (non-redirect) request. The seed `NetworkRecord`
   * carries everything that is known at issue time. The session
   * fills in `t` / `statementSeq` / step path / page url before
   * calling — keeping the coalescer free of clock/recorder deps.
   */
  begin(seed: PendingRecord): void {
    this.pending.set(seed.requestId, seed);
  }

  /**
   * Apply a partial update keyed by the request's `requestId`. Used
   * by the session as `response` / `requestfinished` /
   * `requestfailed` events arrive. Silently ignores updates for
   * unknown ids — happens when `urlFilter` dropped the request at
   * `request` time but a later event still fires.
   */
  update(requestId: string, patch: Partial<NetworkRecord>): void {
    const existing = this.pending.get(requestId);
    if (!existing) return;
    Object.assign(existing, patch);
  }

  /**
   * Mark an exchange as complete and pop it out for emission. The
   * caller writes the record to disk and decides what to do with
   * any buffered body. Returns `undefined` for unknown ids.
   */
  finalize(requestId: string): NetworkRecord | undefined {
    const record = this.pending.get(requestId);
    if (!record) return undefined;
    this.pending.delete(requestId);
    // Strip the WeakMap key — consumers see the public schema only.
    const { __request, ...publicRecord } = record;
    void __request;
    return publicRecord;
  }

  /**
   * At teardown: emit anything still pending so the trace file
   * reflects requests that never finished (e.g. a fetch that
   * outlived the test and was cancelled by `context.close()`).
   * Empties the map.
   */
  drain(): NetworkRecord[] {
    const out: NetworkRecord[] = [];
    for (const [id, record] of this.pending) {
      const { __request, ...publicRecord } = record;
      void __request;
      out.push(publicRecord);
      this.pending.delete(id);
    }
    return out;
  }
}

export function deriveSource(request: PwRequest, contextSource: NetworkSource): NetworkSource {
  // The session passes a hint that says where it observed the event;
  // the coalescer just records it on the seed.
  void request;
  return contextSource;
}
