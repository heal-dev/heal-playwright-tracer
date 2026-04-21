/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
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
   * `./statement-trace-schema.ts` `Statement.leadingComment` for the
   * attachment caveats consumers should know about.
   */
  leadingComment?: string;
}
