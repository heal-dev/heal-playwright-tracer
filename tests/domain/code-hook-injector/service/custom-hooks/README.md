# Custom hooks — tests

This folder mirrors `src/code-hook-injector/hooks/custom-hooks/`.
When a custom hook family lands, its tests live here under a
matching subfolder, at minimum covering:

1. The **matcher** — every positive and negative case the regex or
   predicate is intended to catch, plus tolerance tests for malformed
   or unexpected nodes.
2. The **builder** — the exact AST it emits for a representative
   matched node, asserted via `@babel/generator` round-tripping.
3. A **golden transform test** in
   `tests/code-hook-injector/transform.test.ts` that drives the full
   pipeline end-to-end with `@babel/core`, so the family is exercised
   through the same path Playwright uses at runtime.

See `tests/code-hook-injector/hooks/trace-hook/` for the reference
implementation of the above pattern.
