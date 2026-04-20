// Builds the try/catch/finally wrapper that surrounds every traced
// statement. Generated shape:
//
//   try { /* tryBodyStmts */ }
//   catch (_traceErr) {
//     _traceThrew = true;
//     globalThis.__throw?.(_traceErr);
//     throw _traceErr;
//   }
//   finally {
//     if (!_traceThrew) globalThis.__ok?.(/* okArgs */);
//   }
//
// Plus a sibling `let _traceThrew = false;` declaration that lives
// outside the try block so the finally can read it.
//
// Why the `_traceThrew` flag instead of just putting __ok in the try
// body: normal completion AND early exits (`return`, `break`,
// `continue`) all unwind through the finally, so `__ok` must run on
// unwind too (to keep the active-enter stack balanced on the
// recorder side). Only a caught error should skip `__ok`, and the
// flag lets us distinguish that case without duplicating the call.
//
// Both the declaration and the wrapper are tagged `_traced = true`
// so the Statement visitor doesn't recurse into them.

import type * as BabelTypes from '@babel/types';
import type { Scope } from '@babel/traverse';
import type { GlobalTraceCallBuilder } from './global-trace-call';

type Types = typeof BabelTypes;

interface TracedNode {
  _traced?: boolean;
}

export interface TryFinallyWrapperBuilder {
  buildTryFinally: (
    scope: Scope,
    tryBodyStmts: BabelTypes.Statement[],
    okArgs?: BabelTypes.Expression[],
  ) => { threwId: BabelTypes.Identifier; tryStmt: BabelTypes.TryStatement };
  buildThrewDecl: (threwId: BabelTypes.Identifier) => BabelTypes.VariableDeclaration;
}

export function createTryFinallyWrapperBuilder(
  t: Types,
  buildGlobalTraceCall: GlobalTraceCallBuilder,
): TryFinallyWrapperBuilder {
  function buildTryFinally(
    scope: Scope,
    tryBodyStmts: BabelTypes.Statement[],
    okArgs: BabelTypes.Expression[] = [],
  ) {
    const errId = scope.generateUidIdentifier('traceErr');
    const threwId = scope.generateUidIdentifier('traceThrew');
    const rethrow = t.throwStatement(t.cloneNode(errId));
    (rethrow as TracedNode)._traced = true;
    const assignThrew = t.expressionStatement(
      t.assignmentExpression('=', t.cloneNode(threwId), t.booleanLiteral(true)),
    );
    (assignThrew as TracedNode)._traced = true;
    const catchBlock = t.blockStatement([
      assignThrew,
      buildGlobalTraceCall('__heal_throw', [t.cloneNode(errId)]),
      rethrow,
    ]);
    const finallyBlock = t.blockStatement([
      t.ifStatement(
        t.unaryExpression('!', t.cloneNode(threwId)),
        t.blockStatement([buildGlobalTraceCall('__heal_ok', okArgs)]),
      ),
    ]);
    finallyBlock.body.forEach((n) => {
      (n as TracedNode)._traced = true;
      const withConsequent = n as { consequent?: BabelTypes.Node };
      if (withConsequent.consequent) (withConsequent.consequent as TracedNode)._traced = true;
    });
    const tryStmt = t.tryStatement(
      t.blockStatement(tryBodyStmts),
      t.catchClause(errId, catchBlock),
      finallyBlock,
    );
    (tryStmt as TracedNode)._traced = true;
    return { threwId, tryStmt };
  }

  function buildThrewDecl(threwId: BabelTypes.Identifier): BabelTypes.VariableDeclaration {
    const decl = t.variableDeclaration('let', [
      t.variableDeclarator(threwId, t.booleanLiteral(false)),
    ]);
    (decl as TracedNode)._traced = true;
    return decl;
  }

  return { buildTryFinally, buildThrewDecl };
}
