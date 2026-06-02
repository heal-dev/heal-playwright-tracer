/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// ConsoleCaptureSession — one test's worth of browser-console capture.
//
// Subscribes to `console` and `pageerror` on every page in every
// BrowserContext we are wired to (initial context + popups + any
// context the user opened via `browser.newContext()` in the test
// body). Each event is serialized to a `ConsoleRecord` and appended
// to the per-test `heal-console.ndjson` sidecar. Cross-link to the
// statement stream is via `t` (ms since recorder.startedAt) and the
// top-of-enter-stack `seq` snapshotted at emit time.
//
// Behaviour notes:
//   - `attachToContext(ctx)` is idempotent. A `WeakSet` drops
//     duplicate wiring when the initial page's context is also
//     returned by `browser.contexts()`.
//   - `console-message.args()` are best-effort: each handle is
//     resolved with a small `withTimeout`; on timeout we keep the
//     record but drop `args`. We never block a test on console arg
//     resolution.
//   - The fd is opened lazily on the first record so disabled tests
//     do not write empty files.

import * as fs from 'fs';
import type { BrowserContext, ConsoleMessage, JSHandle, Page } from 'playwright';
import type {
  ConsoleLevel,
  ConsoleRecord,
} from '../../domain/trace-event-recorder/model/console-trace-schema';
import type { HealTracerConsoleConfig } from '../../application/heal-config/types';
import type { Clock } from '../../domain/trace-event-recorder/port/clock';
import { withTimeout } from '../../util/with-timeout';

const ARG_RESOLVE_TIMEOUT_MS = 250;
const DEFAULT_MAX_ARG_BYTES = 4096;
const DEFAULT_MAX_ARGS_PER_EVENT = 10;
// Bounds on the shape of a single resolved arg. `maxArgBytes` only
// caps strings; these cap how deep/wide we walk an object graph so a
// huge framework object (Angular component, zone.js task, …) cannot
// blow up the NDJSON line.
const MAX_ARG_DEPTH = 6;
const MAX_ARG_ENTRIES = 100;

const ALLOWED_LEVELS: readonly ConsoleLevel[] = [
  'log',
  'info',
  'warn',
  'error',
  'debug',
  'trace',
  'pageerror',
];

export interface ConsoleCaptureDeps {
  clock: Clock;
  startedAt: number;
  getCurrentStatementSeq: () => number | undefined;
  getCurrentStepPath: () => string[] | undefined;
}

export class ConsoleCaptureSession {
  private fd: number | undefined;
  private closed = false;
  private readonly contexts = new WeakSet<BrowserContext>();
  private readonly pages = new WeakSet<Page>();
  private readonly levels: ReadonlySet<ConsoleLevel>;
  private readonly maxArgBytes: number;
  private readonly maxArgsPerEvent: number;

  constructor(
    private readonly ndjsonPath: string,
    private readonly deps: ConsoleCaptureDeps,
    config: HealTracerConsoleConfig,
  ) {
    const requested = config.levels ?? ALLOWED_LEVELS;
    this.levels = new Set(requested);
    this.maxArgBytes = config.maxArgBytes ?? DEFAULT_MAX_ARG_BYTES;
    this.maxArgsPerEvent = config.maxArgsPerEvent ?? DEFAULT_MAX_ARGS_PER_EVENT;
  }

  /**
   * Wire `ctx` and every page already living on it. Idempotent. Also
   * subscribes to future pages via `ctx.on('page')` so popups created
   * later in the test body are covered.
   */
  attachToContext(ctx: BrowserContext): void {
    if (this.closed || this.contexts.has(ctx)) return;
    this.contexts.add(ctx);
    for (const page of ctx.pages()) this.attachToPage(page);
    ctx.on('page', (page) => this.attachToPage(page));
  }

  private attachToPage(page: Page): void {
    if (this.closed || this.pages.has(page)) return;
    this.pages.add(page);
    page.on('console', (msg) => this.handleConsole(page, msg));
    page.on('pageerror', (err) => this.handlePageError(page, err));
  }

  private async handleConsole(page: Page, msg: ConsoleMessage): Promise<void> {
    if (this.closed) return;
    const level = mapConsoleType(msg.type());
    if (!this.levels.has(level)) return;

    const args = await this.resolveArgs(msg);
    const loc = msg.location();
    const record: ConsoleRecord = {
      kind: 'console',
      t: this.deps.clock.now() - this.deps.startedAt,
      level,
      text: msg.text(),
      ...(args !== undefined ? { args } : {}),
      ...(loc.url || loc.lineNumber !== undefined
        ? {
            location: {
              ...(loc.url ? { url: loc.url } : {}),
              ...(loc.lineNumber !== undefined ? { line: loc.lineNumber } : {}),
              ...(loc.columnNumber !== undefined ? { col: loc.columnNumber } : {}),
            },
          }
        : {}),
      ...this.snapshotCorrelation(page, msg.page()?.mainFrame()?.url()),
    };
    this.write(record);
  }

  private handlePageError(page: Page, err: Error): void {
    if (this.closed) return;
    if (!this.levels.has('pageerror')) return;
    const record: ConsoleRecord = {
      kind: 'console',
      t: this.deps.clock.now() - this.deps.startedAt,
      level: 'pageerror',
      text: err.message,
      ...(err.stack ? { stack: err.stack } : {}),
      ...this.snapshotCorrelation(page),
    };
    this.write(record);
  }

  private snapshotCorrelation(
    page: Page,
    frameUrl?: string,
  ): Pick<ConsoleRecord, 'statementSeq' | 'stepPath' | 'pageUrl' | 'frameUrl'> {
    const out: Pick<ConsoleRecord, 'statementSeq' | 'stepPath' | 'pageUrl' | 'frameUrl'> = {};
    const seq = this.deps.getCurrentStatementSeq();
    if (seq !== undefined) out.statementSeq = seq;
    const stepPath = this.deps.getCurrentStepPath();
    if (stepPath) out.stepPath = stepPath;
    try {
      const url = page.url();
      if (url) out.pageUrl = url;
    } catch {
      // page may already be closed — ignore.
    }
    if (frameUrl) out.frameUrl = frameUrl;
    return out;
  }

  private async resolveArgs(msg: ConsoleMessage): Promise<unknown[] | undefined> {
    const handles = msg.args();
    if (handles.length === 0) return undefined;
    const trimmed = handles.slice(0, this.maxArgsPerEvent);
    try {
      const resolved = await Promise.all(trimmed.map((h) => this.resolveArg(h)));
      return resolved;
    } catch {
      return undefined;
    }
  }

  private async resolveArg(handle: JSHandle): Promise<unknown> {
    try {
      const value = await withTimeout(
        Promise.resolve(handle.jsonValue()),
        ARG_RESOLVE_TIMEOUT_MS,
        'console-arg.jsonValue',
      );
      return capArg(value, this.maxArgBytes);
    } catch {
      return '<unserializable>';
    }
  }

  private write(record: ConsoleRecord): void {
    if (this.closed) return;
    const line = serializeRecord(record);
    if (line === undefined) return; // nothing we could serialize — never throw.
    try {
      if (this.fd === undefined) this.fd = fs.openSync(this.ndjsonPath, 'a');
      fs.writeSync(this.fd, line + '\n');
    } catch {
      // Sidecar I/O must never throw into the page 'console'/'pageerror'
      // handler (which is un-awaited) and fail the user's test.
    }
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    if (this.fd !== undefined) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // best-effort; fd may already be gone.
      }
      this.fd = undefined;
    }
    return Promise.resolve();
  }
}

function mapConsoleType(type: string): ConsoleLevel {
  switch (type) {
    case 'log':
    case 'info':
    case 'warn':
    case 'error':
    case 'debug':
    case 'trace':
      return type;
    case 'warning':
      return 'warn';
    default:
      return 'log';
  }
}

/**
 * Normalize a resolved console arg into a JSON-safe value.
 *
 * Playwright's `JSHandle.jsonValue()` faithfully rebuilds circular
 * structures into genuinely circular JS objects (see
 * `parseEvaluationResultValue` in playwright-core's
 * `utilityScriptSerializers`), and a framework object can be huge.
 * Passing such a value straight through would make the NDJSON
 * `JSON.stringify` in `write()` throw `Converting circular structure
 * to JSON`. So we walk the graph here:
 *   - cycles are replaced with `'[Circular]'` (ancestor tracking, so
 *     shared-but-acyclic siblings are kept, matching JSON behaviour),
 *   - depth past `MAX_ARG_DEPTH` and entries past `MAX_ARG_ENTRIES`
 *     are collapsed to a marker,
 *   - strings are capped to `maxArgBytes`,
 *   - `bigint`/`function`/`symbol` (which `JSON.stringify` drops or
 *     throws on) become readable strings.
 */
function capArg(value: unknown, maxArgBytes: number): unknown {
  return sanitizeArg(value, maxArgBytes, new WeakSet<object>(), 0);
}

function sanitizeArg(
  value: unknown,
  maxArgBytes: number,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  switch (typeof value) {
    case 'string':
      return capString(value, maxArgBytes);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
    case 'undefined':
      return value;
    case 'bigint':
      return `${value}n`;
    case 'function':
      return value.name ? `[Function: ${value.name}]` : '[Function]';
    case 'symbol':
      return value.toString();
  }
  if (value === null) return null;

  const obj = value as object;
  if (seen.has(obj)) return '[Circular]';

  // Types with a `toJSON` (Date, URL, …) are delegated to it so we
  // reproduce the native `JSON.stringify` output instead of flattening
  // them to `{}` by walking their (empty) own enumerable keys.
  const toJSON = (obj as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') {
    try {
      return sanitizeArg((toJSON as () => unknown).call(obj), maxArgBytes, seen, depth);
    } catch {
      return '<unserializable>';
    }
  }

  if (depth >= MAX_ARG_DEPTH) return Array.isArray(obj) ? '[Array]' : '[Object]';

  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const limit = Math.min(obj.length, MAX_ARG_ENTRIES);
      const out: unknown[] = [];
      for (let i = 0; i < limit; i++) {
        out.push(sanitizeArg(obj[i], maxArgBytes, seen, depth + 1));
      }
      if (obj.length > MAX_ARG_ENTRIES) out.push(`[+${obj.length - MAX_ARG_ENTRIES} more]`);
      return out;
    }
    const keys = Object.keys(obj);
    const out: Record<string, unknown> = {};
    const limit = Math.min(keys.length, MAX_ARG_ENTRIES);
    for (let i = 0; i < limit; i++) {
      const key = keys[i];
      let propValue: unknown;
      try {
        propValue = (obj as Record<string, unknown>)[key];
      } catch {
        propValue = '<unserializable>'; // a throwing getter
      }
      out[key] = sanitizeArg(propValue, maxArgBytes, seen, depth + 1);
    }
    if (keys.length > MAX_ARG_ENTRIES) out['…'] = `[+${keys.length - MAX_ARG_ENTRIES} more]`;
    return out;
  } finally {
    seen.delete(obj);
  }
}

function capString(value: string, maxArgBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxArgBytes) return value;
  return value.slice(0, maxArgBytes) + '…';
}

/**
 * Backstop serializer for the NDJSON line. Arg sanitization should
 * already have made `record` JSON-safe, but if anything slips through
 * (a value `JSON.stringify` still rejects), drop `args` — the only
 * field that can hold an arbitrary value — and keep the rest of the
 * record (`text`, `level`, `location`, correlation). Returns
 * `undefined` only if even the stripped record fails, so the caller
 * can skip the write rather than throw.
 */
function serializeRecord(record: ConsoleRecord): string | undefined {
  try {
    return JSON.stringify(record);
  } catch {
    try {
      const rest = { ...record };
      delete (rest as { args?: unknown }).args;
      return JSON.stringify(rest);
    } catch {
      return undefined;
    }
  }
}
