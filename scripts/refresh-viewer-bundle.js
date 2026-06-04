/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Refreshes the vendored trace viewer SPA bundle inside this repo.
//
// First regenerates the vendored wire types (see gen-viewer-types.js),
// then reads heal-frontend on disk, runs `npm run build` inside its
// `packages/trace-viewer-standalone/` workspace, and replaces the
// committed `tracer-viewer-bundle/` directory at the repo root with
// the freshly built `dist/`. The CLI loads the bundle from
// `tracer-viewer-bundle/` at runtime — no npm publish or
// `node_modules` indirection is involved.
//
// Defaults to a sibling checkout at `../heal-frontend`. Override via
// the `HEAL_FRONTEND_DIR` env var when checked out elsewhere.

const { spawnSync } = require('node:child_process');
const { rmSync, cpSync, existsSync } = require('node:fs');
const path = require('node:path');

const { genViewerTypes, standalonePkg, tracerRoot } = require('./gen-viewer-types');

const sourceDist = path.join(standalonePkg, 'dist');
const bundleDest = path.join(tracerRoot, 'tracer-viewer-bundle');

// ─── Step 0: vendor the local-server wire types into the standalone ─
genViewerTypes();

// ─── Step 1: build the standalone SPA ──────────────────────────────
console.log(`[refresh:viewer] Building in ${standalonePkg}…`);
const buildResult = spawnSync('npm', ['run', 'build'], {
  cwd: standalonePkg,
  stdio: 'inherit',
});

if (buildResult.status !== 0) {
  console.error('[refresh:viewer] vite build failed.');
  process.exit(buildResult.status ?? 1);
}

if (!existsSync(sourceDist)) {
  console.error(
    `[refresh:viewer] expected dist/ output at ${sourceDist} after build, but it is missing.`,
  );
  process.exit(1);
}

// ─── Step 2: replace the committed bundle ──────────────────────────
console.log(`[refresh:viewer] Replacing ${bundleDest}…`);
rmSync(bundleDest, { recursive: true, force: true });
cpSync(sourceDist, bundleDest, { recursive: true });

console.log(
  `[refresh:viewer] ✓ Refreshed.\n  Review and commit:\n    git add tracer-viewer-bundle && git commit`,
);
