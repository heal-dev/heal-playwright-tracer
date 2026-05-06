/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// End-to-end test of the network capture session against stub
// Playwright objects. We don't spin up a browser — we mimic the
// shape of `BrowserContext`/`Request`/`Response` enough for the
// session to drive its lifecycle.

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import type { BrowserContext, Request as PwRequest, Response as PwResponse } from 'playwright';
import { NetworkCaptureSession } from '../../../src/infrastructure/playwright-network-capture-adapter';

function readLines(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function makeRequest(opts: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  postData?: Buffer;
  resourceType?: string;
}): PwRequest {
  const req = {
    url: () => opts.url,
    method: () => opts.method ?? 'GET',
    headers: () => opts.headers ?? {},
    postDataBuffer: () => opts.postData ?? null,
    resourceType: () => opts.resourceType ?? 'fetch',
    isNavigationRequest: () => false,
    response: async () => null,
    timing: () => ({ startTime: 0, responseEnd: 10 }),
    failure: () => null,
    redirectedFrom: () => null,
    frame: () => null,
  };
  return req as unknown as PwRequest;
}

function makeContext(): BrowserContext & {
  emitRequest: (r: PwRequest) => void;
  emitResponse: (r: PwResponse) => void;
  emitFinished: (r: PwRequest) => void;
  emitFailed: (r: PwRequest) => void;
} {
  const emitter = new EventEmitter();
  const ctx = {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    pages: () => [],
    emitRequest: (r: PwRequest) => emitter.emit('request', r),
    emitResponse: (r: PwResponse) => emitter.emit('response', r),
    emitFinished: (r: PwRequest) => emitter.emit('requestfinished', r),
    emitFailed: (r: PwRequest) => emitter.emit('requestfailed', r),
  };
  return ctx as unknown as ReturnType<typeof makeContext>;
}

const clock = { now: () => 1000, wallNow: () => 0 };
const deps = {
  clock,
  startedAt: 1000,
  getCurrentStatementSeq: () => 7 as number | undefined,
  getCurrentStepPath: () => undefined,
};

describe('NetworkCaptureSession', () => {
  let tmpDir: string;
  let ndjsonPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-net-'));
    ndjsonPath = path.join(tmpDir, 'heal-network.ndjson');
  });

  it('coalesces request → response → requestfinished into one record with the active statementSeq', async () => {
    const session = new NetworkCaptureSession(ndjsonPath, deps, { enabled: true });
    const ctx = makeContext();
    session.attachToContext(ctx);

    const req = makeRequest({ url: 'https://example.test/api' });
    ctx.emitRequest(req);
    const resp = {
      request: () => req,
      status: () => 200,
      statusText: () => 'OK',
      headers: () => ({ 'content-type': 'application/json' }),
      body: async () => Buffer.from('{}', 'utf8'),
    } as unknown as PwResponse;
    ctx.emitResponse(resp);
    ctx.emitFinished(req);
    await new Promise((r) => setImmediate(r));

    await session.stop(false);
    const lines = readLines(ndjsonPath);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      kind: 'network',
      method: 'GET',
      url: 'https://example.test/api',
      status: 200,
      statementSeq: 7,
    });
  });

  it('redacts default-denylisted headers', async () => {
    const session = new NetworkCaptureSession(ndjsonPath, deps, { enabled: true });
    const ctx = makeContext();
    session.attachToContext(ctx);

    const req = makeRequest({
      url: 'https://example.test/api',
      headers: { Authorization: 'Bearer hunter2', 'x-custom': 'plain' },
    });
    ctx.emitRequest(req);
    ctx.emitFinished(req);
    await new Promise((r) => setImmediate(r));

    await session.stop(false);
    const [record] = readLines(ndjsonPath) as Array<{
      requestHeaders: Record<string, string>;
    }>;
    expect(record.requestHeaders['Authorization']).toBe('<redacted>');
    expect(record.requestHeaders['x-custom']).toBe('plain');
  });

  it('records a failure record on requestfailed', async () => {
    const session = new NetworkCaptureSession(ndjsonPath, deps, { enabled: true });
    const ctx = makeContext();
    session.attachToContext(ctx);

    const req = {
      ...makeRequest({ url: 'https://example.test/api' }),
      failure: () => ({ errorText: 'net::ERR_FAILED' }),
    } as unknown as PwRequest;
    ctx.emitRequest(req);
    ctx.emitFailed(req);
    await new Promise((r) => setImmediate(r));

    await session.stop(false);
    const [record] = readLines(ndjsonPath) as Array<{
      failure?: { errorText: string };
    }>;
    expect(record.failure?.errorText).toBe('net::ERR_FAILED');
  });

  it('drops requests rejected by urlFilter', async () => {
    const session = new NetworkCaptureSession(ndjsonPath, deps, {
      enabled: true,
      urlFilter: (url) => !url.includes('telemetry'),
    });
    const ctx = makeContext();
    session.attachToContext(ctx);

    ctx.emitRequest(makeRequest({ url: 'https://telemetry.test/' }));
    ctx.emitRequest(makeRequest({ url: 'https://example.test/' }));
    const second = makeRequest({ url: 'https://example.test/' });
    ctx.emitFinished(second); // unrelated id; ignored
    ctx.emitFinished(makeRequest({ url: 'https://example.test/' }));
    await new Promise((r) => setImmediate(r));

    await session.stop(false);
    const lines = readLines(ndjsonPath) as Array<{ url: string }>;
    expect(lines.every((l) => !l.url.includes('telemetry'))).toBe(true);
  });

  it('attachToContext is idempotent — duplicate wires do not duplicate listeners', async () => {
    const session = new NetworkCaptureSession(ndjsonPath, deps, { enabled: true });
    const ctx = makeContext();
    session.attachToContext(ctx);
    session.attachToContext(ctx);

    const req = makeRequest({ url: 'https://example.test/' });
    ctx.emitRequest(req);
    ctx.emitFinished(req);
    await new Promise((r) => setImmediate(r));

    await session.stop(false);
    const lines = readLines(ndjsonPath);
    expect(lines).toHaveLength(1);
  });

  it("bodyMode 'always' inlines a textual response body preview", async () => {
    const session = new NetworkCaptureSession(ndjsonPath, deps, {
      enabled: true,
      bodyMode: 'always',
    });
    const ctx = makeContext();
    session.attachToContext(ctx);

    const req = makeRequest({ url: 'https://example.test/api' });
    ctx.emitRequest(req);
    const respBody = Buffer.from('{"ok":true}', 'utf8');
    const resp = {
      request: () => ({
        ...req,
        response: async () => resp,
      }),
      status: () => 200,
      statusText: () => 'OK',
      headers: () => ({ 'content-type': 'application/json' }),
      body: async () => respBody,
    } as unknown as PwResponse;
    // The session reads the body via `await request.response()` in
    // requestfinished; rebind so the request returns this response.
    Object.assign(req, { response: async () => resp });
    ctx.emitResponse(resp);
    ctx.emitFinished(req);
    await new Promise((r) => setImmediate(r));

    await session.stop(false);
    const [record] = readLines(ndjsonPath) as Array<{
      responseBody?: { preview?: string; bytes?: number; truncated?: boolean };
    }>;
    expect(record.responseBody?.preview).toBe('{"ok":true}');
    expect(record.responseBody?.bytes).toBe(respBody.length);
    expect(record.responseBody?.truncated).toBe(false);
  });

  it("bodyMode 'always' suppresses preview for non-textual content types", async () => {
    const session = new NetworkCaptureSession(ndjsonPath, deps, {
      enabled: true,
      bodyMode: 'always',
    });
    const ctx = makeContext();
    session.attachToContext(ctx);

    const req = makeRequest({ url: 'https://example.test/img' });
    ctx.emitRequest(req);
    const respBody = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
    const resp = {
      request: () => req,
      status: () => 200,
      statusText: () => 'OK',
      headers: () => ({ 'content-type': 'image/png' }),
      body: async () => respBody,
    } as unknown as PwResponse;
    Object.assign(req, { response: async () => resp });
    ctx.emitResponse(resp);
    ctx.emitFinished(req);
    await new Promise((r) => setImmediate(r));

    await session.stop(false);
    const [record] = readLines(ndjsonPath) as Array<{
      responseBody?: { preview?: string };
    }>;
    expect(record.responseBody?.preview).toBeUndefined();
  });

  it("bodyMode 'on-error' flushes buffered bodies as network-body records when the test failed", async () => {
    const session = new NetworkCaptureSession(ndjsonPath, deps, {
      enabled: true,
      bodyMode: 'on-error',
    });
    const ctx = makeContext();
    session.attachToContext(ctx);

    const req = makeRequest({ url: 'https://example.test/api' });
    ctx.emitRequest(req);
    const resp = {
      request: () => req,
      status: () => 500,
      statusText: () => 'Server Error',
      headers: () => ({ 'content-type': 'application/json' }),
      body: async () => Buffer.from('{"err":"boom"}', 'utf8'),
    } as unknown as PwResponse;
    Object.assign(req, { response: async () => resp });
    ctx.emitResponse(resp);
    ctx.emitFinished(req);
    await new Promise((r) => setImmediate(r));

    // Test failed → buffered bodies flushed.
    await session.stop(true);
    const lines = readLines(ndjsonPath) as Array<{
      kind: string;
      responseBody?: { preview?: string };
      requestId?: string;
    }>;
    const network = lines.find((l) => l.kind === 'network');
    const body = lines.find((l) => l.kind === 'network-body');
    expect(network).toBeDefined();
    // The network record itself does NOT carry the body in 'on-error' mode.
    expect(network!.responseBody).toBeUndefined();
    expect(body).toBeDefined();
    expect(body!.responseBody?.preview).toBe('{"err":"boom"}');
    expect(body!.requestId).toBe(network!.requestId);
  });

  it("bodyMode 'on-error' discards buffered bodies when the test passed", async () => {
    const session = new NetworkCaptureSession(ndjsonPath, deps, {
      enabled: true,
      bodyMode: 'on-error',
    });
    const ctx = makeContext();
    session.attachToContext(ctx);

    const req = makeRequest({ url: 'https://example.test/api' });
    ctx.emitRequest(req);
    const resp = {
      request: () => req,
      status: () => 200,
      statusText: () => 'OK',
      headers: () => ({ 'content-type': 'application/json' }),
      body: async () => Buffer.from('{"ok":true}', 'utf8'),
    } as unknown as PwResponse;
    Object.assign(req, { response: async () => resp });
    ctx.emitResponse(resp);
    ctx.emitFinished(req);
    await new Promise((r) => setImmediate(r));

    await session.stop(false);
    const lines = readLines(ndjsonPath) as Array<{ kind: string }>;
    expect(lines.some((l) => l.kind === 'network-body')).toBe(false);
    expect(lines.some((l) => l.kind === 'network')).toBe(true);
  });

  it('redirected requests carry redirectedFromId pointing to the prior leg', async () => {
    const session = new NetworkCaptureSession(ndjsonPath, deps, { enabled: true });
    const ctx = makeContext();
    session.attachToContext(ctx);

    const first = makeRequest({ url: 'https://example.test/old' });
    const second = makeRequest({ url: 'https://example.test/new' });
    Object.assign(second, { redirectedFrom: () => first });

    ctx.emitRequest(first);
    ctx.emitFinished(first);
    ctx.emitRequest(second);
    ctx.emitFinished(second);
    await new Promise((r) => setImmediate(r));

    await session.stop(false);
    const lines = readLines(ndjsonPath) as Array<{
      url: string;
      requestId: string;
      redirectedFromId?: string;
    }>;
    const firstLeg = lines.find((l) => l.url.endsWith('/old'))!;
    const secondLeg = lines.find((l) => l.url.endsWith('/new'))!;
    expect(secondLeg.redirectedFromId).toBe(firstLeg.requestId);
    expect(firstLeg.redirectedFromId).toBeUndefined();
  });

  it('redacts default-denylisted RESPONSE headers (not just request headers)', async () => {
    const session = new NetworkCaptureSession(ndjsonPath, deps, { enabled: true });
    const ctx = makeContext();
    session.attachToContext(ctx);

    const req = makeRequest({ url: 'https://example.test/login' });
    ctx.emitRequest(req);
    const resp = {
      request: () => req,
      status: () => 200,
      statusText: () => 'OK',
      headers: () => ({
        'set-cookie': 'session=abc; Path=/',
        'content-type': 'application/json',
      }),
      body: async () => Buffer.from(''),
    } as unknown as PwResponse;
    Object.assign(req, { response: async () => resp });
    ctx.emitResponse(resp);
    ctx.emitFinished(req);
    await new Promise((r) => setImmediate(r));

    await session.stop(false);
    const [record] = readLines(ndjsonPath) as Array<{
      responseHeaders?: Record<string, string>;
    }>;
    expect(record.responseHeaders?.['set-cookie']).toBe('<redacted>');
    expect(record.responseHeaders?.['content-type']).toBe('application/json');
  });

  it('captures api-request-context traffic via attachToApiRequestContext', async () => {
    const session = new NetworkCaptureSession(ndjsonPath, deps, { enabled: true });
    const apiEmitter = new EventEmitter();
    const apiCtx = {
      on: apiEmitter.on.bind(apiEmitter),
      off: apiEmitter.off.bind(apiEmitter),
    } as unknown as Parameters<typeof session.attachToApiRequestContext>[0];
    session.attachToApiRequestContext(apiCtx);

    const req = makeRequest({ url: 'https://api.test/v1/things' });
    apiEmitter.emit('request', req);
    apiEmitter.emit('requestfinished', req);
    await new Promise((r) => setImmediate(r));

    await session.stop(false);
    const [record] = readLines(ndjsonPath) as Array<{ source: string; url: string }>;
    expect(record.source).toBe('api-request-context');
    expect(record.url).toBe('https://api.test/v1/things');
  });

  it('urlFilter that throws keeps the request rather than dropping it', async () => {
    const session = new NetworkCaptureSession(ndjsonPath, deps, {
      enabled: true,
      urlFilter: () => {
        throw new Error('boom');
      },
    });
    const ctx = makeContext();
    session.attachToContext(ctx);

    const req = makeRequest({ url: 'https://example.test/' });
    ctx.emitRequest(req);
    ctx.emitFinished(req);
    await new Promise((r) => setImmediate(r));

    await session.stop(false);
    expect(readLines(ndjsonPath)).toHaveLength(1);
  });

  it('stop() is idempotent', async () => {
    const session = new NetworkCaptureSession(ndjsonPath, deps, { enabled: true });
    await session.stop(false);
    await expect(session.stop(false)).resolves.toBeUndefined();
  });
});
