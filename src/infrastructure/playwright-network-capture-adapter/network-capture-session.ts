/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// NetworkCaptureSession — one test's worth of HTTP traffic capture.
//
// Subscribes to `request` / `response` / `requestfinished` /
// `requestfailed` on every wired BrowserContext (and on the
// runner-side `APIRequestContext` if any) and coalesces each
// exchange into a single `NetworkRecord` written to the per-test
// `heal-network.ndjson` sidecar.
//
// Lifecycle of a successful exchange:
//   1. `request` fires →
//      - `urlFilter` decides whether to drop;
//      - `coalescer.begin(seed)` registers the in-flight record with
//        the issue-time correlation snapshot (t, statementSeq, ...);
//   2. `response` fires →
//      - `coalescer.update` patches status/headers/body-preview;
//   3. `requestfinished` fires →
//      - the session optionally awaits `response.body()` per
//        bodyMode policy, then calls `coalescer.finalize` to pop the
//        record and writes it (or buffers bodies for `'on-error'`).
//
// On `requestfailed`, the `failure` field is populated and the
// record is flushed immediately — there will be no `response` event.
//
// `attachToContext` and `attachToApiRequestContext` are idempotent
// (WeakSet); the session can be wired to many contexts created
// during a test without worrying about double-listening.

import * as fs from 'fs';
import type {
  APIRequestContext,
  BrowserContext,
  Request as PwRequest,
  Response as PwResponse,
} from 'playwright';
import type {
  NetworkBodyPreview,
  NetworkBodyRecord,
  NetworkRecord,
  NetworkSource,
} from '../../domain/trace-event-recorder/model/network-trace-schema';
import type {
  HealTracerNetworkBodyMode,
  HealTracerNetworkConfig,
} from '../../application/heal-config/types';
import type { Clock } from '../../domain/trace-event-recorder/port/clock';
import { NetworkCoalescer, type PendingRecord } from './network-coalescer';
import { redactHeaders } from './redaction';
import { bytesOnlyPreview, isTextualContentType, previewBody } from './body-preview';
import { withTimeout } from '../../util/with-timeout';

const DEFAULT_MAX_BODY_BYTES = 8192;
const BODY_READ_TIMEOUT_MS = 2000;

/**
 * Public HTTP methods on `APIRequestContext` that we patch to capture
 * runner-side traffic. `fetch` is the unified entry point; the others
 * are convenience methods that may or may not delegate to it depending
 * on Playwright's version, so we patch all of them.
 */
const API_METHODS: readonly string[] = Object.freeze([
  'fetch',
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
]);

interface ApiPatch {
  target: Record<string, unknown>;
  method: string;
  original: (...args: unknown[]) => Promise<unknown>;
}

export interface NetworkCaptureDeps {
  clock: Clock;
  startedAt: number;
  getCurrentStatementSeq: () => number | undefined;
  getCurrentStepPath: () => string[] | undefined;
}

interface BufferedBodies {
  request?: NetworkBodyPreview;
  response?: NetworkBodyPreview;
}

export class NetworkCaptureSession {
  private fd: number | undefined;
  private closed = false;
  private readonly contexts = new WeakSet<BrowserContext>();
  private readonly apiContexts = new WeakSet<APIRequestContext>();
  private readonly apiPatches: ApiPatch[] = [];
  private apiCounter = 1;
  private readonly coalescer = new NetworkCoalescer();
  private readonly bufferedBodies = new Map<string, BufferedBodies>();
  private readonly bodyMode: HealTracerNetworkBodyMode;
  private readonly maxBodyBytes: number;
  private readonly extraDenylist: readonly string[] | undefined;
  private readonly contentTypeAllowlist: readonly RegExp[] | undefined;
  private readonly urlFilter: HealTracerNetworkConfig['urlFilter'];

  constructor(
    private readonly ndjsonPath: string,
    private readonly deps: NetworkCaptureDeps,
    config: HealTracerNetworkConfig,
  ) {
    this.bodyMode = config.bodyMode ?? 'never';
    this.maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.extraDenylist = config.redactHeaders;
    this.contentTypeAllowlist = config.contentTypeAllowlist;
    this.urlFilter = config.urlFilter;
  }

  attachToContext(ctx: BrowserContext): void {
    if (this.closed || this.contexts.has(ctx)) return;
    this.contexts.add(ctx);
    ctx.on('request', (req) => this.handleRequest(req, 'browser-context'));
    ctx.on('response', (resp) => this.handleResponse(resp));
    ctx.on('requestfinished', (req) => {
      void this.handleRequestFinished(req);
    });
    ctx.on('requestfailed', (req) => this.handleRequestFailed(req));
  }

  attachToApiRequestContext(api: APIRequestContext): void {
    if (this.closed || this.apiContexts.has(api)) return;
    this.apiContexts.add(api);
    // `APIRequestContext` does NOT expose public `request`/`response`
    // events the way BrowserContext does — the event surface is
    // browser-side only. To capture runner-side `request.get(...)`
    // traffic we patch the public HTTP methods on the instance,
    // synthesize a `NetworkRecord` per call, and write it directly.
    // No coalescer / redirect tracking — the Playwright fetch
    // internally follows redirects and only surfaces the final
    // `APIResponse`, so a single record per call is correct.
    //
    // Patches are reverted in `stop()` (api contexts are usually
    // worker-scoped, so a stale patch would leak into the next test
    // in the same worker).
    const patchTarget = api as unknown as Record<string, unknown>;
    for (const method of API_METHODS) {
      const original = patchTarget[method];
      if (typeof original !== 'function') continue;
      const originalFn = original as (...args: unknown[]) => Promise<unknown>;
      this.apiPatches.push({ target: patchTarget, method, original: originalFn });
      patchTarget[method] = async (...args: unknown[]): Promise<unknown> => {
        if (this.closed) return originalFn.apply(api, args);
        const record = this.beginApiRecord(method, args);
        try {
          const response = await originalFn.apply(api, args);
          this.completeApiRecord(record, response);
          return response;
        } catch (err) {
          this.failApiRecord(record, err);
          throw err;
        }
      };
    }
  }

  private beginApiRecord(method: string, args: unknown[]): NetworkRecord {
    const [first, second] = args;
    const options =
      (typeof second === 'object' && second !== null ? (second as Record<string, unknown>) : {}) ??
      {};
    const optionsHeaders =
      (options.headers && typeof options.headers === 'object'
        ? (options.headers as Record<string, string>)
        : {}) ?? {};
    const optionsMethod =
      typeof options.method === 'string' ? options.method.toUpperCase() : undefined;

    let url: string;
    if (typeof first === 'string') {
      url = first;
    } else if (first && typeof (first as { url?: unknown }).url === 'function') {
      url = (first as { url: () => string }).url();
    } else {
      url = '';
    }
    const httpMethod = optionsMethod ?? (method === 'fetch' ? 'GET' : method.toUpperCase());

    const requestId = `api-${this.apiCounter++}`;
    const requestHeaders = redactHeaders(optionsHeaders, this.extraDenylist);

    return {
      kind: 'network',
      t: this.deps.clock.now() - this.deps.startedAt,
      requestId,
      source: 'api-request-context',
      method: httpMethod,
      url,
      requestHeaders,
      ...this.snapshotApiCorrelation(),
    };
  }

  private completeApiRecord(record: NetworkRecord, response: unknown): void {
    if (response && typeof response === 'object') {
      const r = response as {
        status?: () => number;
        statusText?: () => string;
        headers?: () => Record<string, string>;
      };
      try {
        if (typeof r.status === 'function') record.status = r.status();
      } catch {
        /* ignore */
      }
      try {
        if (typeof r.statusText === 'function') record.statusText = r.statusText();
      } catch {
        /* ignore */
      }
      try {
        if (typeof r.headers === 'function') {
          record.responseHeaders = redactHeaders(r.headers(), this.extraDenylist);
        }
      } catch {
        /* ignore */
      }
    }
    record.duration = Math.max(0, this.deps.clock.now() - this.deps.startedAt - record.t);
    this.write(record);
  }

  private failApiRecord(record: NetworkRecord, err: unknown): void {
    record.failure = {
      errorText: err instanceof Error ? err.message : String(err),
    };
    record.duration = Math.max(0, this.deps.clock.now() - this.deps.startedAt - record.t);
    this.write(record);
  }

  private snapshotApiCorrelation(): Pick<NetworkRecord, 'statementSeq' | 'stepPath'> {
    const out: Pick<NetworkRecord, 'statementSeq' | 'stepPath'> = {};
    const seq = this.deps.getCurrentStatementSeq();
    if (seq !== undefined) out.statementSeq = seq;
    const stepPath = this.deps.getCurrentStepPath();
    if (stepPath) out.stepPath = stepPath;
    return out;
  }

  private handleRequest(request: PwRequest, source: NetworkSource): void {
    if (this.closed) return;
    const url = safeUrl(request);
    if (this.urlFilter) {
      try {
        if (!this.urlFilter(url, request)) return;
      } catch {
        // user filter threw — keep the request rather than drop it.
      }
    }

    const requestId = this.coalescer.idFor(request);
    const priorId = redirectedFromIdFor(request, this.coalescer);
    const requestHeaders = redactHeaders(safeHeaders(request), this.extraDenylist);

    const seed: PendingRecord = {
      kind: 'network',
      t: this.deps.clock.now() - this.deps.startedAt,
      requestId,
      source,
      method: safeMethod(request),
      url,
      ...(safeResourceType(request) ? { resourceType: safeResourceType(request) } : {}),
      isNavigationRequest: safeIsNavigationRequest(request),
      ...(priorId ? { redirectedFromId: priorId } : {}),
      requestHeaders,
      ...this.snapshotCorrelation(request),
      __request: request,
    };

    this.coalescer.begin(seed);

    if (this.bodyMode !== 'never') {
      const buf = safePostDataBuffer(request);
      if (buf) {
        const ct = headerLookup(seed.requestHeaders, 'content-type');
        const decode = isTextualContentType(ct, this.contentTypeAllowlist);
        const preview = previewBody(buf, this.maxBodyBytes, decode);
        if (this.bodyMode === 'always') {
          seed.requestBody = preview;
        } else {
          // 'on-error' — buffer, don't write.
          this.bufferedBodies.set(requestId, {
            ...(this.bufferedBodies.get(requestId) ?? {}),
            request: preview,
          });
        }
      } else {
        const len = parseContentLength(headerLookup(safeHeaders(request), 'content-length'));
        const bytesOnly = bytesOnlyPreview(len);
        if (bytesOnly && this.bodyMode === 'always') seed.requestBody = bytesOnly;
      }
    }
  }

  private handleResponse(response: PwResponse): void {
    if (this.closed) return;
    const request = response.request();
    if (!this.coalescer.has(request)) return;
    const requestId = this.coalescer.idFor(request);
    const responseHeaders = redactHeaders(safeResponseHeaders(response), this.extraDenylist);
    const update: Partial<NetworkRecord> = {
      status: response.status(),
      statusText: response.statusText(),
      responseHeaders,
      fromServiceWorker: safeFromServiceWorker(response),
    };
    const security = safeSecurityDetails(response);
    if (security) update.securityDetails = security;
    const server = safeServerAddr(response);
    if (server) update.serverAddr = server;
    this.coalescer.update(requestId, update);
  }

  private async handleRequestFinished(request: PwRequest): Promise<void> {
    if (this.closed) return;
    if (!this.coalescer.has(request)) return;
    const requestId = this.coalescer.idFor(request);
    const response = await safeResponse(request);

    if (response && this.bodyMode !== 'never') {
      const headers = safeResponseHeaders(response);
      const ct = headerLookup(headers, 'content-type');
      const len = parseContentLength(headerLookup(headers, 'content-length'));
      const wantText = isTextualContentType(ct, this.contentTypeAllowlist);
      // Skip buffering huge payloads even before reading.
      const willBuffer = wantText && (len === undefined || len <= this.maxBodyBytes * 4);
      if (willBuffer) {
        try {
          const buf = await withTimeout(response.body(), BODY_READ_TIMEOUT_MS, 'response.body');
          const preview = previewBody(buf, this.maxBodyBytes, true);
          if (this.bodyMode === 'always') {
            this.coalescer.update(requestId, { responseBody: preview });
          } else {
            this.bufferedBodies.set(requestId, {
              ...(this.bufferedBodies.get(requestId) ?? {}),
              response: preview,
            });
          }
        } catch {
          // body unavailable (interrupted, redirect, …) — record bytes-only.
          const fallback = bytesOnlyPreview(len);
          if (fallback && this.bodyMode === 'always') {
            this.coalescer.update(requestId, { responseBody: fallback });
          }
        }
      } else {
        const fallback = bytesOnlyPreview(len);
        if (fallback && this.bodyMode === 'always') {
          this.coalescer.update(requestId, { responseBody: fallback });
        }
      }
    }

    const timing = safeTiming(request);
    if (timing) this.coalescer.update(requestId, { timing });
    const finishedAt = this.deps.clock.now() - this.deps.startedAt;
    const record = this.coalescer.finalize(requestId);
    if (!record) return;
    record.duration = Math.max(0, finishedAt - record.t);
    this.write(record);
  }

  private handleRequestFailed(request: PwRequest): void {
    if (this.closed) return;
    if (!this.coalescer.has(request)) return;
    const requestId = this.coalescer.idFor(request);
    const failureText = safeFailure(request);
    if (failureText) {
      this.coalescer.update(requestId, { failure: { errorText: failureText } });
    }
    const failedAt = this.deps.clock.now() - this.deps.startedAt;
    const record = this.coalescer.finalize(requestId);
    if (!record) return;
    record.duration = Math.max(0, failedAt - record.t);
    this.write(record);
  }

  private snapshotCorrelation(
    request: PwRequest,
  ): Pick<NetworkRecord, 'statementSeq' | 'stepPath' | 'pageUrl' | 'frameUrl'> {
    const out: Pick<NetworkRecord, 'statementSeq' | 'stepPath' | 'pageUrl' | 'frameUrl'> = {};
    const seq = this.deps.getCurrentStatementSeq();
    if (seq !== undefined) out.statementSeq = seq;
    const stepPath = this.deps.getCurrentStepPath();
    if (stepPath) out.stepPath = stepPath;
    const frame = safeFrame(request);
    if (frame) {
      try {
        const frameUrl = frame.url();
        if (frameUrl) out.frameUrl = frameUrl;
        const page = frame.page();
        const pageUrl = page?.url();
        if (pageUrl) out.pageUrl = pageUrl;
      } catch {
        // ignore — frame may have been detached.
      }
    }
    return out;
  }

  private write(record: NetworkRecord): void {
    if (this.closed) return;
    if (this.fd === undefined) this.fd = fs.openSync(this.ndjsonPath, 'a');
    fs.writeSync(this.fd, JSON.stringify(record) + '\n');
  }

  /**
   * Drain any pending exchanges (writing them as-is) and, when the
   * test ended in a failing status and `bodyMode === 'on-error'`,
   * flush buffered bodies as `network-body` records. Idempotent.
   *
   * The body is currently fully synchronous (every disk write is
   * `fs.writeSync`); the `Promise<void>` return type is preserved so
   * the fixture can await it under `withTimeout` exactly like
   * `projector.finalize`.
   */
  stop(testFailed: boolean): Promise<void> {
    if (this.closed) return Promise.resolve();
    // Revert APIRequestContext method patches first so any callbacks
    // that fire during the rest of teardown see the originals.
    for (const patch of this.apiPatches) {
      patch.target[patch.method] = patch.original;
    }
    this.apiPatches.length = 0;
    for (const stale of this.coalescer.drain()) {
      stale.duration = Math.max(0, this.deps.clock.now() - this.deps.startedAt - stale.t);
      this.write(stale);
    }
    if (this.bodyMode === 'on-error' && testFailed) {
      for (const [requestId, bodies] of this.bufferedBodies) {
        if (!bodies.request && !bodies.response) continue;
        const bodyRecord: NetworkBodyRecord = {
          kind: 'network-body',
          requestId,
          ...(bodies.request ? { requestBody: bodies.request } : {}),
          ...(bodies.response ? { responseBody: bodies.response } : {}),
        };
        if (this.fd === undefined) this.fd = fs.openSync(this.ndjsonPath, 'a');
        fs.writeSync(this.fd, JSON.stringify(bodyRecord) + '\n');
      }
    }
    this.bufferedBodies.clear();
    this.closed = true;
    if (this.fd !== undefined) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // best-effort.
      }
      this.fd = undefined;
    }
    return Promise.resolve();
  }
}

// ---- Playwright surface guards ----
//
// These tiny wrappers swallow the very narrow set of throws Playwright
// can surface from frozen / closed contexts. Without them, a single
// torn-down page would crash the entire trace. Each helper returns a
// safe default and the session keeps going.

function safeUrl(request: PwRequest): string {
  try {
    return request.url();
  } catch {
    return '';
  }
}

function safeMethod(request: PwRequest): string {
  try {
    return request.method();
  } catch {
    return '';
  }
}

function safeHeaders(request: PwRequest): Record<string, string> {
  try {
    return request.headers();
  } catch {
    return {};
  }
}

function safeResponseHeaders(response: PwResponse): Record<string, string> {
  try {
    return response.headers();
  } catch {
    return {};
  }
}

function safeResourceType(request: PwRequest): string | undefined {
  try {
    const fn = (request as unknown as { resourceType?: () => string }).resourceType;
    return typeof fn === 'function' ? fn.call(request) : undefined;
  } catch {
    return undefined;
  }
}

function safeIsNavigationRequest(request: PwRequest): boolean | undefined {
  try {
    const fn = (request as unknown as { isNavigationRequest?: () => boolean }).isNavigationRequest;
    return typeof fn === 'function' ? fn.call(request) : undefined;
  } catch {
    return undefined;
  }
}

function safePostDataBuffer(request: PwRequest): Buffer | null {
  try {
    return request.postDataBuffer();
  } catch {
    return null;
  }
}

async function safeResponse(request: PwRequest): Promise<PwResponse | null> {
  try {
    return await request.response();
  } catch {
    return null;
  }
}

function safeFromServiceWorker(response: PwResponse): boolean | undefined {
  try {
    const fn = (response as unknown as { fromServiceWorker?: () => boolean }).fromServiceWorker;
    return typeof fn === 'function' ? fn.call(response) : undefined;
  } catch {
    return undefined;
  }
}

function safeSecurityDetails(response: PwResponse): NetworkRecord['securityDetails'] | undefined {
  try {
    const fn = (
      response as unknown as {
        securityDetails?: () => Promise<{
          protocol?: string;
          subjectName?: string;
          issuer?: string;
          validFrom?: number;
          validTo?: number;
        } | null>;
      }
    ).securityDetails;
    if (typeof fn !== 'function') return undefined;
    // Playwright's API is async; we don't await here to keep the
    // response handler synchronous. If users want full detail they
    // can extend later — the field stays undefined for now.
    void fn;
    return undefined;
  } catch {
    return undefined;
  }
}

function safeServerAddr(response: PwResponse): NetworkRecord['serverAddr'] | undefined {
  try {
    const fn = (
      response as unknown as {
        serverAddr?: () => Promise<{ ipAddress?: string; port?: number } | null>;
      }
    ).serverAddr;
    if (typeof fn !== 'function') return undefined;
    void fn;
    return undefined;
  } catch {
    return undefined;
  }
}

function safeTiming(request: PwRequest): NetworkRecord['timing'] | undefined {
  try {
    const fn = (request as unknown as { timing?: () => NetworkRecord['timing'] }).timing;
    return typeof fn === 'function' ? fn.call(request) : undefined;
  } catch {
    return undefined;
  }
}

function safeFailure(request: PwRequest): string | undefined {
  try {
    const fn = (request as unknown as { failure?: () => { errorText?: string } | null }).failure;
    if (typeof fn !== 'function') return undefined;
    return fn.call(request)?.errorText;
  } catch {
    return undefined;
  }
}

function safeFrame(request: PwRequest): {
  url: () => string;
  page: () => { url: () => string } | null;
} | null {
  try {
    const fn = (
      request as unknown as {
        frame?: () => { url: () => string; page: () => { url: () => string } | null } | null;
      }
    ).frame;
    return typeof fn === 'function' ? fn.call(request) : null;
  } catch {
    return null;
  }
}

function redirectedFromIdFor(request: PwRequest, coalescer: NetworkCoalescer): string | undefined {
  try {
    const fn = (request as unknown as { redirectedFrom?: () => PwRequest | null }).redirectedFrom;
    const prior = typeof fn === 'function' ? fn.call(request) : null;
    if (!prior) return undefined;
    return coalescer.idFor(prior);
  } catch {
    return undefined;
  }
}

function headerLookup(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function parseContentLength(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
