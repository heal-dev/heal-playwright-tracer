/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Refreshes the vendored trace viewer SPA bundle inside this repo.
//
// Reads heal-frontend on disk, runs `npm run build` inside its
// `packages/trace-viewer-standalone/` workspace, then replaces the
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

const tracerRoot = path.resolve(__dirname, '..');
const healFrontend = path.resolve(
  process.env.HEAL_FRONTEND_DIR ?? path.join(tracerRoot, '..', 'heal-frontend'),
);
const standalonePkg = path.join(healFrontend, 'packages', 'trace-viewer-standalone');
const sourceDist = path.join(standalonePkg, 'dist');
const bundleDest = path.join(tracerRoot, 'tracer-viewer-bundle');

if (!existsSync(standalonePkg)) {
  console.error(
    `[refresh:viewer] heal-frontend's trace-viewer-standalone not found at:\n  ${standalonePkg}\n\nSet HEAL_FRONTEND_DIR or check out heal-frontend as a sibling directory.`,
  );
  process.exit(1);
}

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

console.log(`[refresh:viewer] Replacing ${bundleDest}…`);
rmSync(bundleDest, { recursive: true, force: true });
cpSync(sourceDist, bundleDest, { recursive: true });

console.log(
  `[refresh:viewer] ✓ Refreshed.\n  Review and commit:\n    git add tracer-viewer-bundle && git commit`,
);
