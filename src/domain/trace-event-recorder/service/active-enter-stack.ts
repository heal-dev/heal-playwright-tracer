/**
 * Copyright (c) Myia SAS 2026 - All Rights Reserved
 */

import type { EnterEvent } from '../model/trace-schema';

export class ActiveEnterStack {
  private readonly stack: EnterEvent[] = [];

  push(event: EnterEvent): void {
    this.stack.push(event);
  }

  pop(): EnterEvent | undefined {
    return this.stack.pop();
  }

  peek(): EnterEvent | undefined {
    return this.stack[this.stack.length - 1];
  }

  depth(): number {
    return this.stack.length;
  }

  parentSeq(): number | null {
    if (this.stack.length === 0) return null;
    return this.stack[this.stack.length - 1].seq;
  }

  clear(): void {
    this.stack.length = 0;
  }
}
