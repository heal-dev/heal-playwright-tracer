# Custom hooks

This folder is reserved for statement-level code-injection strategies
other than the trace hook. Each subfolder here will be one **hook
family**: a matcher that decides when the hook applies, plus a builder
that emits the AST the hook injects.

Expected future shape, per family:

```
custom-hooks/<hook-family-name>/
├── <family>-matcher.ts    — (path, state) => boolean
└── <family>-builder.ts    — (path, state) => void   // mutates AST
```

Wire the family into
`src/code-hook-injector/babel-plugin-entrypoint.ts`'s `Statement`
visitor next to the existing trace-hook application, and mirror the
file layout under `tests/code-hook-injector/hooks/custom-hooks/`.

The trace hook in `../trace-hook/` is the reference implementation —
it's the widest-scoped custom hook (applies to every leaf statement)
and shows the full pattern: match → build meta → build wrapper →
replace. Most custom hooks will be narrower (regex-matched Playwright
API calls, specific statement shapes, etc.), but the file organization
stays the same.
