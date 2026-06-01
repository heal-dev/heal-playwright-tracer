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
const { createHash } = require('node:crypto');
const { rmSync, cpSync, existsSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');

const tracerRoot = path.resolve(__dirname, '..');
const healFrontend = path.resolve(
  process.env.HEAL_FRONTEND_DIR ?? path.join(tracerRoot, '..', 'heal-frontend'),
);
const standalonePkg = path.join(healFrontend, 'packages', 'trace-viewer-standalone');
const sourceDist = path.join(standalonePkg, 'dist');
const bundleDest = path.join(tracerRoot, 'tracer-viewer-bundle');

// Source of truth for the wire types the standalone vendors verbatim.
const VENDOR_SOURCE_REL = 'src/infrastructure/local-viewer-adapter/analyze-wire-types.ts';
const VENDOR_DEST_REL = 'src/generated/heal-tracer-api-types.ts';
const vendorSource = path.join(tracerRoot, VENDOR_SOURCE_REL);
const vendorDest = path.join(standalonePkg, VENDOR_DEST_REL);

if (!existsSync(standalonePkg)) {
  console.error(
    `[refresh:viewer] heal-frontend's trace-viewer-standalone not found at:\n  ${standalonePkg}\n\nSet HEAL_FRONTEND_DIR or check out heal-frontend as a sibling directory.`,
  );
  process.exit(1);
}

// ─── Step 0: vendor analyze wire types into the standalone ─────────
//
// The standalone used to install the tracer via a local `file:` tarball
// to import these types. That path doesn't exist on Vercel, so install
// (and therefore `apps/web` build) failed there. We instead vendor the
// types: one self-contained source file in the tracer, copied 1:1 into
// the standalone with a sha256 of the source embedded in the header so
// drift is detectable. Skipped when the source hasn't changed.
console.log(`[refresh:viewer] Checking vendored types at ${VENDOR_DEST_REL}…`);
if (!existsSync(vendorSource)) {
  console.error(`[refresh:viewer] missing vendor source: ${vendorSource}`);
  process.exit(1);
}
const vendorSourceBody = readFileSync(vendorSource, 'utf8');
const vendorChecksum = `sha256-${createHash('sha256').update(vendorSourceBody).digest('hex')}`;

const existingVendor = existsSync(vendorDest) ? readFileSync(vendorDest, 'utf8') : null;
const existingChecksum = existingVendor?.match(/Source checksum:\s*(sha256-[a-f0-9]+)/)?.[1];

if (existingChecksum === vendorChecksum) {
  console.log(`[refresh:viewer] ✓ Vendored types up to date (${vendorChecksum.slice(0, 19)}…).`);
} else {
  // heal-frontend's eslint `header/header` rule requires the Myia
  // copyright as the FIRST block comment, written with `/***` (three
  // asterisks — its config matches the block CONTENT, which means the
  // second `*` is part of the expected content). The GENERATED notice
  // follows as the second block, then the vendored source body — with
  // its OWN tracer-side copyright block stripped, since one copyright
  // header per file is what the lint rule will accept.
  const frontendCopyrightYear = new Date().getFullYear();
  const sourceBodyEmbedded = vendorSourceBody.replace(/^\s*\/\*\*[\s\S]*?\*\/\n*/, '');
  const header = `/***
 * Copyright (c) Myia 2023-${frontendCopyrightYear} - All Rights Reserved
 */

/**
 * GENERATED — do not edit by hand.
 *
 * Vendored from heal-playwright-tracer:
 *   ${VENDOR_SOURCE_REL}
 *
 * Source checksum: ${vendorChecksum}
 *
 * Regenerate in the heal-playwright-tracer repo:
 *   npm run refresh:viewer
 *
 * Manual edits will be silently overwritten on the next refresh.
 */

`;
  mkdirSync(path.dirname(vendorDest), { recursive: true });
  writeFileSync(vendorDest, header + sourceBodyEmbedded, 'utf8');
  console.log(
    existingChecksum
      ? `[refresh:viewer] ✓ Vendored types updated (${existingChecksum.slice(0, 19)}… → ${vendorChecksum.slice(0, 19)}…).`
      : `[refresh:viewer] ✓ Vendored types written (${vendorChecksum.slice(0, 19)}…).`,
  );
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
