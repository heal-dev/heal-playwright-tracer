# How the trace-event-recorder works

## The one-sentence version

The trace-event-recorder is a factory that hands back `__enter` /
`__ok` / `__throw` functions; those functions push/pop a stack and
write events to a sink, pairing every statement's start with its end
and computing the duration from a clock delta.

## Pipeline diagram

```
┌───────────────────────────────────────────────────────────────────┐
│  Instrumented test code runs                                       │
│    globalThis.__enter(meta);                                       │
│    try { user statement }                                          │
│    catch (e) { globalThis.__throw(e); throw e }                    │
│    finally { if (!threw) globalThis.__ok(vars?) }                  │
└──────────────────────────────┬────────────────────────────────────┘
                               │
                               ▼
            ┌──────────────────────────────────────────────┐
            │  src/trace-event-recorder/entrypoint.ts      │
            │        default instance, installs            │
            │    __enter/__ok/__throw on globalThis        │
            └──────────────────┬───────────────────────────┘
                               │ delegates to
                               ▼
            ┌──────────────────────────────────────────────┐
            │    src/trace-event-recorder/factory.ts       │
            │   createTraceEventRecorder({ sink, clock })  │
            │              (composition root)              │
            └──────────────────┬───────────────────────────┘
                               │
                               ▼
                    ┌─────────────────────────┐
                    │ TraceEventRecorderState │
                    │    (shared mutable)     │
                    │                      │
                    │  • sink              │
                    │  • clock             │
                    │  • staticContext     │
                    │  • dynamicContext    │
                    │  • currentPage       │
                    │  • enterStack  ◄──── the heart: pairs __enter
                    │  • stepStack         │   with __ok/__throw
                    │  • seq               │
                    │  • startedAt         │
                    └──────────┬───────────┘
                               │ passed to every event builder
                               │
     ┌─────────────┬───────────┼───────────┬─────────────┐
     ▼             ▼           ▼           ▼             ▼
  ╔═════════╗ ╔═════════╗ ╔════════╗ ╔═══════════╗ ╔═════════════╗
  ║ enter-  ║ ║  ok-    ║ ║ throw- ║ ║  meta-    ║ ║ playwright- ║
  ║ event-  ║ ║ event-  ║ ║ event- ║ ║  event-   ║ ║ api-event-  ║
  ║ builder ║ ║ builder ║ ║ builder║ ║  builder  ║ ║   builder   ║
  ╚════╦════╝ ╚════╦════╝ ╚═══╦════╝ ╚═════╦═════╝ ╚══════╦══════╝
       │           │          │            │              │
       │ push      │ pop      │ pop(opt.)  │ (no stack)   │ (no stack)
       ▼           ▼          ▼            ▼              ▼
                  state.enterStack
                  +
                  state.sink.write(event)
                               │
                               ▼
            ┌───────────────────────────────────────────┐
            │     src/trace-event-recorder/ports/       │
            │     trace-sink.ts  (port interface)       │
            │     clock.ts       (port interface)       │
            └──────────────────┬────────────────────────┘
                               │ implemented by
                               ▼
            ┌───────────────────────────────────────────┐
            │     src/trace-event-recorder/adapters/    │
            │     memory-sink.ts        (default)       │
            │     perf-hooks-clock.ts   (default)       │
            └──────────────────┬────────────────────────┘
                               │
                               ▼
                    (events buffered in memory)
                               │
                               ▼
            trace-output feature reads snapshot()
            at fixture teardown and writes
            statement-trace.json → attach to report
```

## The active-enter stack — what makes it work

```
time ─────────────────────────────►

__enter(outer)                              ┌── pushes event A
  ├── push A                                │   seq=2  depth=0  parentSeq=null
  │                                         │
  │   __enter(inner)                    ┌───┤── pushes event B
  │     ├── push B                      │   │   seq=3  depth=1  parentSeq=2
  │     │                               │   │
  │     │   (user statement runs)       │   │
  │     │                               │   │
  │     └── __ok()                      └───┤── pops B,   emits ok
  │           pop B   ──► duration =         │   seq=4, enterSeq=3
  │                    now - B.t             │   duration = 12ms
  │                                          │
  │   (more outer code runs)                 │
  │                                          │
  └── __ok()                                 └── pops A,   emits ok
        pop A   ──► duration =                   seq=5, enterSeq=2
                 now - A.t                       duration = 87ms
```

**Why the stack matters:**

- Every `__enter` push records `depth` (= current stack size) and
  `parentSeq` (= seq of the current top) so the tree structure is
  stamped into the event at push time.
- Every `__ok`/`__throw` pop looks up the matching enter event's `t`
  and computes `duration = now - enter.t`.
- `return` / `break` / `continue` still unwind through the `finally`
  clause the instrumenter generates, so they still pop — the stack
  stays balanced.

## Per-event shapes

```
reset()                                enter/ok/throw
  │                                             │
  ▼                                             ▼
{type:'meta',                             {type:'enter', seq, parentSeq, depth,
 seq:1, t:0,                               t, wallTime, file, startLine,
 wallTime,                                 endLine, kind, scope, hasAwait,
 ...staticContext,      ──►                source, step, stepPath, pageUrl,
 ...dynamicContext}                        screenshot?}   ← mutated post-emit by
                                                            locator-screenshots
                                          {type:'ok', seq, enterSeq,
                                           t, wallTime, duration, vars?}

                                          {type:'throw', seq, enterSeq,
                                           t, wallTime, duration,
                                           error: {name, message, stack,
                                                   isPlaywrightError, causes?}}
```

## Key design choices the diagram encodes

1. **The state is the object, not a closure.** `TraceEventRecorderState`
   is an explicitly-typed record that flows through every event
   builder. That's what lets each event builder live in its own file
   and be tested with a stub state.
2. **The stack is the heart.** `active-enter-stack.ts` owns the
   push/pop that turns a linear stream of calls into a tree with
   `depth` and `parentSeq`. If the stack gets corrupted, everything
   downstream is wrong.
3. **Ports and adapters are consistent.** `sink` and `clock` are both
   ports with default adapters; both can be swapped in tests. Nothing
   else in the trace-event-recorder knows about `perf_hooks` or an
   in-memory array.
4. **Duration is all we measure.** Just `duration = now - enter.t` on
   pop. No cpu, no heap, no event-loop lag — the consumer only needs
   wall-clock execution time per statement.
5. **`__throw` tolerates orphan pops.** If `enterStack.pop()` returns
   `undefined` (an error escaping the very first statement of a run),
   the throw event still emits with `enterSeq: null` and `duration: 0`
   instead of crashing.
