# ESM and CommonJS — what works, what breaks, why

Module-format interactions are the single most common source of
integration bugs with this package. They're also the category of bug
where the stack trace points at the wrong file 90% of the time, so
it's worth understanding the full picture before you start digging.

## How this package is shipped

`heal-playwright-tracer` ships as **CommonJS**, and that's deliberate.

- `src/code-hook-injector.ts` is authored in TS but emits CJS
  (`module.exports = ...` via `export =`). It is consumed by
  Playwright's babel transform, which is itself a CJS module loaded
  via `require()`. There's no upside to ESM here — Playwright will
  `require()` the injector either way.
- `src/trace-event-recorder/entrypoint.ts`, `src/index.ts`, and everything under
  `src/features/` also compile to CJS (`dist/**/*.js`) via `tsc` with
  `module: commonjs`. Consumers `import` from `heal-playwright-tracer`;
  Node's CJS/ESM interop handles the rest.
- `package.json` has no `"type"` field. The default is `commonjs`,
  which matches what we actually emit. Adding `"type": "module"` would
  break the code-hook-injector entry because Node would then interpret
  `.js` files as ESM.

The `exports` map in `package.json` carries three entries —
`.`, `./code-hook-injector`, `./trace-event-recorder` — each with
a single `default` condition. We deliberately do not have
`import`/`require` split conditions because we only publish one
artifact per entry point.

## How consumers integrate

Consumers fall into two categories, and **both work** as long as their
`playwright.config.ts` matches the package's declared module type.

### CJS consumer (default)

```jsonc
// package.json  (no "type" field, or "type": "commonjs")
```

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  '@playwright/test': {
    babelPlugins: [
      [
        require.resolve('heal-playwright-tracer/code-hook-injector'),
        {
          /* opts */
        },
      ],
    ],
  },
});
```

`require` is a global in CJS, so `require.resolve(...)` just works.
This is the smoothest path and the one I'd recommend unless the rest
of the test package is already ESM.

### ESM consumer

```jsonc
// package.json
{ "type": "module" }
```

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export default defineConfig({
  '@playwright/test': {
    babelPlugins: [
      [
        require.resolve('heal-playwright-tracer/code-hook-injector'),
        {
          /* opts */
        },
      ],
    ],
  },
});
```

The `createRequire(import.meta.url)` dance exists **only** because
Playwright's `babelPlugins` array expects a resolved path string, and
there's no ESM equivalent of `require.resolve` in Node's standard
library without importing `node:module`. `import.meta.resolve` would
work in newer Node versions, but it returns a `file://` URL that
Playwright doesn't accept — stick with `createRequire` for now.

## The config-file format trap

This is the one that bit us in the `twenty` repo and the one most
likely to bite you too. The rule:

> **The module format of `playwright.config.ts` must match the
> `"type"` field of its nearest `package.json`.** If they disagree,
> Node's newer `require(esm)` fast path can route the file through the
> ESM loader while Playwright's babel transform is still emitting CJS
> output, and you get:
>
> ```
> ReferenceError: exports is not defined in ES module scope
>     at file:///.../playwright.config.ts:3:23
> ```

The trap: `import.meta.url` is **ESM-only syntax**. If you paste it
into a config file whose nearest `package.json` is CJS (or has no
`type` field, which defaults to CJS), Node 22+ will statically scan
the file, see `import.meta`, decide it's ESM, and hand it to the ESM
loader. The loader then executes code that Babel compiled assuming
CJS output — `Object.defineProperty(exports, ...)` — and blows up on
the very first line of the prelude because `exports` doesn't exist in
an ES module scope.

The fix is always one of:

1. **Remove the ESM-only syntax** (preferred for CJS packages). Drop
   `createRequire(import.meta.url)` and just use the bare `require`
   global — it's already there in CJS.
2. **Add `"type": "module"`** to `package.json` and let Playwright
   load the config through its real ESM path. This is invasive in an
   existing package — you'll also need to audit relative imports for
   explicit file extensions.
3. **Rename the config to `.cts` or `.mts`** to pin its format
   independently of `package.json`. Works, but surprising to readers
   and some tooling doesn't handle `.cts` well.

The thing that makes this trap especially nasty is that the stack
trace blames our plugin even though our plugin has never run at this
point. Playwright's own code path (`configLoader.js:107` →
`requireOrImport` → `transformHook`) loads the config **before**
reading `babelPlugins` from it, so whatever is configured in
`defineConfig({ '@playwright/test': { babelPlugins } })` has zero
effect on how the config file itself is parsed. The plugin is
innocent — the format mismatch pre-dates it.

## Pitfalls inside instrumented files

Once Playwright is running and our plugin is active, the babel AST it
sees for each instrumented file is **post-CJS-transform**, even for
packages authored in ESM. Playwright's pipeline runs
`@babel/plugin-transform-modules-commonjs` before user plugins, so by
the time our `Statement` visitor fires:

- `import { foo } from 'bar'` has already become
  `var _bar = require("bar")`.
- `export const foo = ...` has become either
  `var foo = exports.foo = ...` or
  `Object.defineProperty(exports, "foo", { get: () => foo })`,
  depending on Babel version.
- `export function f() {}` has become a hoisted function declaration
  plus `exports.f = f`.

We have to skip all of the above, and a few gotchas fall out of that:

- **Don't instrument `require()` bindings at the top of a file.** If
  we wrapped `var _bar = require("bar")` in a `try { _bar = ... }`
  block, the first `__enter` call would fire before the runtime had
  been `require()`'d. `isGeneratedModuleStatement` in `plugin.js`
  catches this (in `src/code-hook-injector/statement-analysis/cjs-artifact-detector.ts`)
  — it looks for `VariableDeclaration`s whose initializers are
  `require(...)` or `_interopRequire*(require(...))` and bails out.
- **Don't instrument declarations that live inside an
  `ExportDeclaration`.** When Babel traverses into
  `ExportNamedDeclaration.declaration`, our `Statement` visitor fires
  on the inner `VariableDeclaration` and, without a guard, would try
  to `replaceWithMultiple` on a single-node slot — which corrupts the
  export. The guard is
  `path.parentPath.isExportDeclaration()` at the top of the visitor.
  If you're touching the visitor, don't remove this check.
- **Use `globalThis.__enter?.(...)` rather than bare `__enter(...)`.**
  Playwright ships user callbacks to the browser via
  `Function.prototype.toString()`. If we'd written bare identifier
  calls, those stringified bodies would crash in the browser VM with
  `ReferenceError: __enter is not defined`. The optional call on a
  global lookup silently no-ops in any context where the runtime
  isn't installed. Istanbul hit this same issue years ago and landed
  on the same solution.

## Module-format translation of the `@playwright/test` import

Our plugin's `Program` visitor rewrites `from '@playwright/test'` to
`from 'heal-playwright-tracer'` in every instrumented file, so test
authors can keep the standard import and still get our auto-fixture.
This rewrite is **format-agnostic**: we mutate the AST
`ImportDeclaration.source.value` before any modules transform has
run. Whether Playwright later emits CJS or ESM output, the string
literal in the source slot is already the one we want.

The only case where the rewrite is visible in a weird way is when a
file was authored in CJS and uses `require('@playwright/test')`
instead of an import. Our Program visitor only touches
`ImportDeclaration` nodes — it won't rewrite `require()` calls. This
is intentional: instrumented test files should be using `import`
anyway, and rewriting arbitrary `require()` calls has a much wider
blast radius than rewriting import declarations. If you hit a case
where this matters, write the import and let Babel's modules-commonjs
transform convert it for you.

## Debugging checklist

When a consumer reports a module-format error involving this package,
walk this list top to bottom before doing anything else:

1. Is the stack trace actually inside our code, or is it in
   Playwright's own config loader? If the frame is in
   `configLoader.js` or `transform.js` with no frame from our package
   in between, it's a config-file issue, not an instrumentation one.
2. What does `packages/<consumer>/package.json` say for `"type"`?
   What syntax does `playwright.config.ts` use (`import.meta.*`,
   top-level `await`, `createRequire`)? If they disagree, that's the
   bug — fix the config, not the plugin.
3. Is the error specifically `exports is not defined in ES module
scope`? That's the Node `require(esm)` / ESM-scope trap. Go read
   the config-file-format-trap section above.
4. Is the error `__enter is not defined`? That means an instrumented
   function got stringified and shipped to a VM that doesn't have the
   recorder installed — usually a browser context. Our optional-chain
   call should have prevented this; check whether someone edited
   `buildGlobalTraceCall` in
   `src/code-hook-injector/hooks/trace-hook/global-trace-call.ts` and
   dropped the `globalThis.` prefix.
5. Only _after_ ruling the above out, suspect our Statement visitor.
