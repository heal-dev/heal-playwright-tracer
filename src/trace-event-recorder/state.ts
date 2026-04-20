// TraceEventRecorderState — the mutable state held by a single
// trace-event-recorder instance.
//
// Every event builder in ./event-builders/ takes a reference to this
// object, reads/mutates what it needs, and writes the resulting event
// to `state.sink`. Keeping the state in one explicitly-typed shape
// (instead of closing it over inside a factory) is what lets each
// event builder live in its own file and be unit-tested with a stub
// state.
//
// This file also holds the two trace-event-recorder-shared types
// that downstream files need: the `EnterMeta` shape that the
// Babel-injected `__enter(...)` call passes in, and the
// `SCHEMA_VERSION` constant stamped on every meta event.

import type { TraceSink } from './ports/trace-sink';
import type { Clock } from './ports/clock';
import type { ActiveEnterStack } from './active-enter-stack';

export const SCHEMA_VERSION = 1;

/**
 * Payload that the Babel-injected `__enter(...)` call passes to the
 * trace-event-recorder for every traced statement. Mirrors the
 * ObjectExpression built by
 * `src/code-hook-injector/trace-hook/enter-meta-literal.ts`.
 */
export interface EnterMeta {
  file: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  kind: string;
  scope: string;
  hasAwait: boolean;
  source: string;
  /**
   * User-written `// …` / `/* … *\/` comments attached to this
   * statement's AST node, joined with `\n` in source order. Present
   * only when the parser attached at least one comment; see
   * `features/trace-output/statement-trace-schema.ts` `Statement.
   * leadingComment` for the attachment caveats consumers should
   * know about.
   */
  leadingComment?: string;
}

export interface TraceEventRecorderState {
  // Injected dependencies.
  sink: TraceSink;
  clock: Clock;

  // Per-process static context (pid, gitSha, …) — merged into every
  // meta event emitted by reset().
  staticContext: Record<string, unknown>;

  // Per-test dynamic context set via setContext() — merged into
  // every meta event. Cleared to null between runs.
  dynamicContext: Record<string, unknown> | null;

  // The Playwright page associated with the current test. Used by
  // the enter-event-builder to attach `pageUrl` to every enter event.
  currentPage: unknown;

  // The active-enter stack — pairs each __enter with its matching
  // __ok/__throw and derives `depth` and `parentSeq` for the
  // currently-running statement.
  enterStack: ActiveEnterStack;

  // Nested test.step titles pushed via pushStep/popStep.
  stepStack: string[];

  // Monotonically increasing sequence number, stamped on every event.
  seq: number;

  // Origin for relative `t` values. Reset at the start of every run
  // so each trace begins at t=0.
  startedAt: number;
}
