/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */

import type * as BabelTypes from '@babel/types';
import type { Scope } from '@babel/traverse';
import type { GlobalTraceCallBuilder } from './global-trace-call';
import { HEAL_OK, HEAL_THROW } from '../../../trace-event-recorder/model/global-names';

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
      buildGlobalTraceCall(HEAL_THROW, [t.cloneNode(errId)]),
      rethrow,
    ]);
    const finallyBlock = t.blockStatement([
      t.ifStatement(
        t.unaryExpression('!', t.cloneNode(threwId)),
        t.blockStatement([buildGlobalTraceCall(HEAL_OK, okArgs)]),
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
