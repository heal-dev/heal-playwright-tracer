# Refreshing the trace viewer bundle

The `heal-tracer view` CLI serves a static SPA out of the
`tracer-viewer-bundle/` directory at the root of this repo. The
bundle is built from heal-frontend's `packages/trace-viewer-standalone/`
workspace and committed here as a build artefact — there is no
`@heal-dev/front-trace-viewer-standalone` package on npm to install.

When the viewer UI changes upstream, you must rebuild the bundle and
commit the diff. This doc covers that workflow.

## Prerequisites

- A local checkout of `heal-frontend`, by default at the sibling path
  `../heal-frontend` (i.e. alongside `heal-playwright-tracer`).
- `node_modules` installed in heal-frontend (`npm install` from its
  repo root). The first run will be slow; subsequent refreshes reuse
  the workspace cache.
- Override the heal-frontend location with the `HEAL_FRONTEND_DIR`
  env var if your checkout lives elsewhere.

## Refresh

From this repo's root:

```bash
npm run refresh:viewer
```

Behind the scenes the script does three things:

1. Runs `npm run build` inside
   `<heal-frontend>/packages/trace-viewer-standalone/` (Vite build).
2. Removes the existing `tracer-viewer-bundle/` directory in this repo.
3. Copies the freshly built `dist/` into `tracer-viewer-bundle/`.

Override the heal-frontend path:

```bash
HEAL_FRONTEND_DIR=/path/to/heal-frontend npm run refresh:viewer
```

## Review and commit

Vite outputs content-hashed filenames, so a refresh typically replaces
`tracer-viewer-bundle/assets/*.js` and `*.css` with newly hashed
versions and leaves `index.html` re-pointing at them. Inspect the diff
to confirm only the bundle changed:

```bash
git status tracer-viewer-bundle
git diff --stat tracer-viewer-bundle
```

Then commit:

```bash
git add tracer-viewer-bundle
git commit -m "chore: refresh trace viewer bundle"
```

Pair the commit with whatever heal-frontend change motivated the
refresh, ideally referencing the heal-frontend PR or commit hash in
the body.

## What gets shipped

The `tracer-viewer-bundle/` directory is listed in the `files` array
of this repo's `package.json`, so it lands in the published tarball
when you `npm publish`. Users who `npm install
@heal-dev/heal-playwright-tracer` get the viewer for free — no
optional dep, no fallback path, no missing-asset error mode.

## License boundary

The bundle is proprietary heal-frontend build output redistributed
under the AGPL-licensed surrounding tracer package. The
`tracer-viewer-bundle/NOTICE.md` file inside the directory states
this explicitly. **Do not edit files under `tracer-viewer-bundle/`
directly** — the next refresh will overwrite your edits, and the
upstream source is the only place the changes belong.

## Troubleshooting

**`heal-frontend's trace-viewer-standalone not found at: …`**
Either heal-frontend isn't checked out at the expected sibling path
or your override is wrong. Fix the path or set `HEAL_FRONTEND_DIR`.

**`vite build failed.`**
Run the same build directly in heal-frontend to see the unfiltered
output:

```bash
cd $HEAL_FRONTEND_DIR/packages/trace-viewer-standalone
npm run build
```

Common causes: stale `node_modules` after a heal-frontend dep change
(`npm install` from heal-frontend root fixes it), or a TypeScript
error in the upstream code that needs to be addressed there first.

**`expected dist/ output at … but it is missing.`**
Vite reported success but didn't emit `dist/`. Almost always a
working-directory or symlink quirk — re-run from a clean checkout.

## Related

- `scripts/refresh-viewer-bundle.js` — the script `npm run
refresh:viewer` invokes.
- `src/application/commander-cli-adapter/commander-cli-adapter.ts` —
  resolves the bundle path at runtime via `defaultBundleDir()`.
- `src/infrastructure/local-viewer-adapter/local-viewer-server.ts` —
  serves the bundle over HTTP and exposes `/api/*` against the user's
  `test-results/`.
- `docs/cli-roadmap.md` — feature roadmap for the `heal-tracer` CLI.
