/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import type { BrowserContext, ConsoleMessage, JSHandle, Page } from 'playwright';
import { ConsoleCaptureSession } from '../../../src/infrastructure/playwright-console-capture-adapter';

function readLines(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function makePage(url = 'https://example.test/') {
  const emitter = new EventEmitter();
  const page = {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    url: () => url,
    mainFrame: () => ({ url: () => url }),
  };
  return { page: page as unknown as Page, emitter };
}

function makeContext(initialPages: Page[] = []) {
  const emitter = new EventEmitter();
  const ctx = {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    pages: () => initialPages,
  };
  return { ctx: ctx as unknown as BrowserContext, emitter };
}

function makeMessage(opts: {
  type: string;
  text: string;
  args?: unknown[];
  url?: string;
  line?: number;
  col?: number;
}): ConsoleMessage {
  const args = (opts.args ?? []).map((value): JSHandle => {
    return {
      jsonValue: async () => value,
    } as unknown as JSHandle;
  });
  const msg = {
    type: () => opts.type,
    text: () => opts.text,
    args: () => args,
    location: () => ({
      url: opts.url ?? '',
      lineNumber: opts.line ?? 0,
      columnNumber: opts.col ?? 0,
    }),
    page: () => null,
  };
  return msg as unknown as ConsoleMessage;
}

const clock = { now: () => 1500, wallNow: () => 0 };
const deps = {
  clock,
  startedAt: 1000,
  getCurrentStatementSeq: () => 12 as number | undefined,
  getCurrentStepPath: () => ['outer', 'inner'] as string[] | undefined,
};

describe('ConsoleCaptureSession', () => {
  let tmpDir: string;
  let ndjsonPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-console-'));
    ndjsonPath = path.join(tmpDir, 'heal-console.ndjson');
  });

  it('writes one record per console.log with statementSeq + stepPath snapshot', async () => {
    const session = new ConsoleCaptureSession(ndjsonPath, deps, { enabled: true });
    const { page, emitter: pageEmitter } = makePage();
    const { ctx } = makeContext([page]);
    session.attachToContext(ctx);

    pageEmitter.emit('console', makeMessage({ type: 'log', text: 'hello', args: ['hello'] }));
    await new Promise((r) => setImmediate(r));
    await session.close();

    const [record] = readLines(ndjsonPath) as Array<{
      level: string;
      text: string;
      statementSeq: number;
      stepPath: string[];
      t: number;
      pageUrl: string;
    }>;
    expect(record.level).toBe('log');
    expect(record.text).toBe('hello');
    expect(record.statementSeq).toBe(12);
    expect(record.stepPath).toEqual(['outer', 'inner']);
    expect(record.t).toBe(500);
    expect(record.pageUrl).toBe('https://example.test/');
  });

  it('captures pageerror with stack and no args', async () => {
    const session = new ConsoleCaptureSession(ndjsonPath, deps, { enabled: true });
    const { page, emitter: pageEmitter } = makePage();
    const { ctx } = makeContext([page]);
    session.attachToContext(ctx);

    const err = new Error('boom');
    err.stack = 'Error: boom\n  at runFoo';
    pageEmitter.emit('pageerror', err);
    await new Promise((r) => setImmediate(r));
    await session.close();

    const [record] = readLines(ndjsonPath) as Array<{
      level: string;
      text: string;
      stack: string;
      args?: unknown[];
    }>;
    expect(record.level).toBe('pageerror');
    expect(record.text).toBe('boom');
    expect(record.stack).toContain('runFoo');
    expect(record.args).toBeUndefined();
  });

  it('drops levels not in the configured allowlist', async () => {
    const session = new ConsoleCaptureSession(ndjsonPath, deps, {
      enabled: true,
      levels: ['error', 'pageerror'],
    });
    const { page, emitter: pageEmitter } = makePage();
    const { ctx } = makeContext([page]);
    session.attachToContext(ctx);

    pageEmitter.emit('console', makeMessage({ type: 'log', text: 'ignored' }));
    pageEmitter.emit('console', makeMessage({ type: 'error', text: 'kept' }));
    await new Promise((r) => setImmediate(r));
    await session.close();

    const lines = readLines(ndjsonPath) as Array<{ text: string }>;
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('kept');
  });

  it("attachToContext also catches pages opened later via ctx.on('page')", async () => {
    const session = new ConsoleCaptureSession(ndjsonPath, deps, { enabled: true });
    const { ctx, emitter: ctxEmitter } = makeContext([]);
    session.attachToContext(ctx);

    const { page, emitter: pageEmitter } = makePage('https://popup.test/');
    ctxEmitter.emit('page', page);
    pageEmitter.emit('console', makeMessage({ type: 'log', text: 'from popup' }));
    await new Promise((r) => setImmediate(r));
    await session.close();

    const [record] = readLines(ndjsonPath) as Array<{ pageUrl: string; text: string }>;
    expect(record.pageUrl).toBe('https://popup.test/');
    expect(record.text).toBe('from popup');
  });

  it('resolves console.* args via JSHandle.jsonValue()', async () => {
    const session = new ConsoleCaptureSession(ndjsonPath, deps, { enabled: true });
    const { page, emitter: pageEmitter } = makePage();
    const { ctx } = makeContext([page]);
    session.attachToContext(ctx);

    pageEmitter.emit(
      'console',
      makeMessage({
        type: 'log',
        text: 'multi',
        args: ['hello', 42, { nested: true }],
      }),
    );
    await new Promise((r) => setImmediate(r));
    await session.close();

    const [record] = readLines(ndjsonPath) as Array<{ args?: unknown[] }>;
    expect(record.args).toEqual(['hello', 42, { nested: true }]);
  });

  it('caps the number of args per event via maxArgsPerEvent', async () => {
    const session = new ConsoleCaptureSession(ndjsonPath, deps, {
      enabled: true,
      maxArgsPerEvent: 2,
    });
    const { page, emitter: pageEmitter } = makePage();
    const { ctx } = makeContext([page]);
    session.attachToContext(ctx);

    pageEmitter.emit('console', makeMessage({ type: 'log', text: 'many', args: [1, 2, 3, 4, 5] }));
    await new Promise((r) => setImmediate(r));
    await session.close();

    const [record] = readLines(ndjsonPath) as Array<{ args?: unknown[] }>;
    expect(record.args).toHaveLength(2);
    expect(record.args).toEqual([1, 2]);
  });

  it('truncates string args longer than maxArgBytes', async () => {
    const session = new ConsoleCaptureSession(ndjsonPath, deps, {
      enabled: true,
      maxArgBytes: 5,
    });
    const { page, emitter: pageEmitter } = makePage();
    const { ctx } = makeContext([page]);
    session.attachToContext(ctx);

    pageEmitter.emit('console', makeMessage({ type: 'log', text: 'long', args: ['helloworld'] }));
    await new Promise((r) => setImmediate(r));
    await session.close();

    const [record] = readLines(ndjsonPath) as Array<{ args?: unknown[] }>;
    expect(record.args).toEqual(['hello…']);
  });

  it('attachToContext is idempotent — duplicate wires do not duplicate listeners', async () => {
    const session = new ConsoleCaptureSession(ndjsonPath, deps, { enabled: true });
    const { page, emitter: pageEmitter } = makePage();
    const { ctx } = makeContext([page]);
    session.attachToContext(ctx);
    session.attachToContext(ctx);

    pageEmitter.emit('console', makeMessage({ type: 'log', text: 'once' }));
    await new Promise((r) => setImmediate(r));
    await session.close();

    expect(readLines(ndjsonPath)).toHaveLength(1);
  });

  it('close() is idempotent', async () => {
    const session = new ConsoleCaptureSession(ndjsonPath, deps, { enabled: true });
    await session.close();
    await expect(session.close()).resolves.toBeUndefined();
  });

  it('opens the file lazily — disabled tests do not write empty files', async () => {
    const session = new ConsoleCaptureSession(ndjsonPath, deps, {
      enabled: true,
      levels: ['error'],
    });
    const { page, emitter: pageEmitter } = makePage();
    const { ctx } = makeContext([page]);
    session.attachToContext(ctx);

    pageEmitter.emit('console', makeMessage({ type: 'log', text: 'dropped' }));
    await new Promise((r) => setImmediate(r));
    await session.close();

    expect(fs.existsSync(ndjsonPath)).toBe(false);
  });
});
