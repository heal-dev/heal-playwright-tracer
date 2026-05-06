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
    if (this.fd === undefined) this.fd = fs.openSync(this.ndjsonPath, 'a');
    fs.writeSync(this.fd, JSON.stringify(record) + '\n');
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
 * Defensive cap on arg payload size — strings that exceed the byte
 * budget are sliced to `maxArgBytes` UTF-8 characters; non-string
 * values pass through unchanged (they will be re-encoded by the
 * NDJSON `JSON.stringify` and the natural JSON size is acceptable).
 */
function capArg(value: unknown, maxArgBytes: number): unknown {
  if (typeof value !== 'string') return value;
  if (Buffer.byteLength(value, 'utf8') <= maxArgBytes) return value;
  return value.slice(0, maxArgBytes) + '…';
}
