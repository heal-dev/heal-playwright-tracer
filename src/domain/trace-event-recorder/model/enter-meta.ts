/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 */
// EnterMeta — the cross-boundary payload that the Babel-injected
// `__enter(...)` call passes to the trace-event-recorder for every
// traced statement.
//
// This is a contract file: it must stay in sync with the AST literal
// emitted by the code-hook-injector Babel plugin in
// `src/domain/code-hook-injector/service/trace-hook/enter-meta-literal.ts`.
// Any field added here must also be emitted by the plugin, and vice
// versa. Because it is the shape of an object flowing from the Babel
// plugin's generated code into the recorder at runtime, it belongs
// next to the other cross-boundary schemas in `model/` rather than
// under `service/`.

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
   * `./statement-trace-schema.ts` `Statement.leadingComment` for the
   * attachment caveats consumers should know about.
   */
  leadingComment?: string;
}
