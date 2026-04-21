/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 *
 */

// Builds the `ObjectExpression` that becomes the argument to
// `globalThis.__enter?.(...)` — i.e. the `meta` object the recorder
// sees for every traced statement:
//
//   { file, startLine, startCol, endLine, endCol, kind, scope,
//     hasAwait, source, leadingComment? }
//
// Each field is produced by a dedicated helper file:
//   - file           → relative-file-path (relFile)
//   - start/end      → node.loc (attached by the babel parser)
//   - kind           → leaf-statement-classifier (kindOf)
//   - scope          → enclosing-scope-labeler (findScopeName)
//   - hasAwait       → leaf-statement-classifier (containsAwait)
//   - source         → source-snippet-extractor (extractSource)
//   - leadingComment → leading-comment-extractor (extractLeadingComment)
//
// `leadingComment` is the only optional field — it is omitted from
// the emitted ObjectExpression entirely when the statement has no
// attached user comments, so the runtime meta object stays the
// same shape as before for the common case.
//
// This file is the only place that knows what fields the meta object
// contains; downstream consumers (the recorder, tests) read field
// names off the emitted events.

import type * as BabelTypes from '@babel/types';
import type { NodePath } from '@babel/traverse';
import type { PluginPass } from '@babel/core';

type Types = typeof BabelTypes;

interface MetaHelpers {
  kindOf: (node: BabelTypes.Node) => string;
  containsAwait: (node: BabelTypes.Node) => boolean;
  findScopeName: (nodePath: NodePath) => string;
  extractSource: (code: string | undefined | null, node: BabelTypes.Node) => string;
  extractLeadingComment: (node: BabelTypes.Node) => string | null;
  relFile: (cwd: string, absFile: string | undefined | null) => string;
}

export type EnterMetaLiteralBuilder = (
  state: PluginPass,
  nodePath: NodePath,
  node: BabelTypes.Node,
  cwd: string,
) => BabelTypes.ObjectExpression;

export function createEnterMetaLiteralBuilder(
  t: Types,
  helpers: MetaHelpers,
): EnterMetaLiteralBuilder {
  const { kindOf, containsAwait, findScopeName, extractSource, extractLeadingComment, relFile } =
    helpers;

  return function buildEnterMetaLiteral(state, nodePath, node, cwd) {
    const file = relFile(cwd, state.file.opts.filename);
    const loc = node.loc!;
    const properties: BabelTypes.ObjectProperty[] = [
      t.objectProperty(t.identifier('file'), t.stringLiteral(file)),
      t.objectProperty(t.identifier('startLine'), t.numericLiteral(loc.start.line)),
      t.objectProperty(t.identifier('startCol'), t.numericLiteral(loc.start.column)),
      t.objectProperty(t.identifier('endLine'), t.numericLiteral(loc.end.line)),
      t.objectProperty(t.identifier('endCol'), t.numericLiteral(loc.end.column)),
      t.objectProperty(t.identifier('kind'), t.stringLiteral(kindOf(node))),
      t.objectProperty(t.identifier('scope'), t.stringLiteral(findScopeName(nodePath))),
      t.objectProperty(t.identifier('hasAwait'), t.booleanLiteral(containsAwait(node))),
      t.objectProperty(
        t.identifier('source'),
        t.stringLiteral(extractSource((state.file as { code?: string }).code, node)),
      ),
    ];

    // Optional — only emit when the source has an attached comment
    // so the common case stays at 9 keys and no `"leadingComment":
    // null` leaks into the NDJSON.
    const leadingComment = extractLeadingComment(node);
    if (leadingComment !== null) {
      properties.push(
        t.objectProperty(t.identifier('leadingComment'), t.stringLiteral(leadingComment)),
      );
    }

    return t.objectExpression(properties);
  };
}
