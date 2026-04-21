/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import type * as BabelTypes from '@babel/types';

type Types = typeof BabelTypes;

interface TracedNode {
  _traced?: boolean;
}

export type GlobalTraceCallBuilder = (
  name: string,
  args: BabelTypes.Expression[],
) => BabelTypes.ExpressionStatement;

export function createGlobalTraceCallBuilder(t: Types): GlobalTraceCallBuilder {
  return function buildGlobalTraceCall(name, args) {
    const callee = t.memberExpression(t.identifier('globalThis'), t.identifier(name));
    const stmt = t.expressionStatement(t.optionalCallExpression(callee, args, /* optional */ true));
    (stmt as TracedNode)._traced = true;
    return stmt;
  };
}
