/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Vendors the local-server wire-type closure into heal-frontend's
// trace-viewer-standalone as ONE self-contained generated file.
//
// The standalone used to install the tracer via a local `file:` tarball
// to import these types. That path doesn't exist on Vercel, so install
// (and therefore `apps/web` build) failed there. We instead vendor the
// types: the self-contained closure of source files in the tracer,
// concatenated into a single standalone file with a sha256 of the
// sources embedded in the header so drift is detectable. A no-op when
// no source has changed.
//
// Run on its own with `npm run gen:viewer-types`; also invoked by
// `npm run refresh:viewer` before it builds the SPA bundle.
//
// Defaults to a sibling checkout at `../heal-frontend`. Override via
// the `HEAL_FRONTEND_DIR` env var when checked out elsewhere.

const { createHash } = require('node:crypto');
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');

const tracerRoot = path.resolve(__dirname, '..');
const healFrontend = path.resolve(
  process.env.HEAL_FRONTEND_DIR ?? path.join(tracerRoot, '..', 'heal-frontend'),
);
const standalonePkg = path.join(healFrontend, 'packages', 'trace-viewer-standalone');

// Source-of-truth wire-type files the standalone vendors. The full
// dependency closure of the local-server API is concatenated into ONE
// self-contained file, so the standalone typechecks the whole wire
// contract without a `file:` dependency on the tracer tarball. Order
// matters: a declaration must precede its first use, so leaf domain
// types come before the API surface that references them.
const VENDOR_SOURCES_REL = [
  'src/domain/persistence/test-status.ts',
  'src/domain/trace-event-recorder/model/statement-trace-schema.ts',
  'src/infrastructure/local-viewer-adapter/analyze-wire-types.ts',
  'src/infrastructure/local-viewer-adapter/local-server-api-types.ts',
];
const VENDOR_DEST_REL = 'src/generated/heal-tracer-api-types.ts';
const vendorDest = path.join(standalonePkg, VENDOR_DEST_REL);

// Rewrites one source file for inlining into the combined vendored
// file: drops its own copyright block, every `import`, every
// `export … from '…'` re-export, and every bare `export { … }` /
// `export type { … }` re-export (whose names are declared inline by
// another file in the closure). Only the actual type/const/interface
// declarations survive — each symbol then appears exactly once.
//
// The `[^}]*` (not `[\s\S]*?`) inside the brace patterns is load-bearing:
// an export/import list never nests braces, and `[^}]*` stops at the
// first `}`, so a bare `export { … };` can't make the regex run on to a
// later `} from '…'` and swallow every declaration in between.
function inlineVendorBody(body) {
  return body
    .replace(/^\s*\/\*\*[\s\S]*?\*\/\n*/, '')
    .replace(/^import\b[^;]*;[^\n]*\n/gm, '')
    .replace(/^export\s+(?:type\s+)?\{[^}]*\}\s*from\s*['"][^'"]+['"];[^\n]*\n/gm, '')
    .replace(/^export\b[^\n{]*\bfrom\s*['"][^'"]+['"];[^\n]*\n/gm, '')
    .replace(/^export\s+(?:type\s+)?\{[^}]*\};[^\n]*\n/gm, '')
    .trim();
}

function genViewerTypes() {
  if (!existsSync(standalonePkg)) {
    console.error(
      `[gen:viewer-types] heal-frontend's trace-viewer-standalone not found at:\n  ${standalonePkg}\n\nSet HEAL_FRONTEND_DIR or check out heal-frontend as a sibling directory.`,
    );
    process.exit(1);
  }

  console.log(`[gen:viewer-types] Checking vendored types at ${VENDOR_DEST_REL}…`);
  const vendorSources = VENDOR_SOURCES_REL.map((rel) => {
    const abs = path.join(tracerRoot, rel);
    if (!existsSync(abs)) {
      console.error(`[gen:viewer-types] missing vendor source: ${abs}`);
      process.exit(1);
    }
    return { rel, body: readFileSync(abs, 'utf8') };
  });
  const vendorChecksum = `sha256-${createHash('sha256')
    .update(vendorSources.map((s) => s.body).join('\n'))
    .digest('hex')}`;

  const existingVendor = existsSync(vendorDest) ? readFileSync(vendorDest, 'utf8') : null;
  const existingChecksum = existingVendor?.match(/Source checksum:\s*(sha256-[a-f0-9]+)/)?.[1];

  if (existingChecksum === vendorChecksum) {
    console.log(
      `[gen:viewer-types] ✓ Vendored types up to date (${vendorChecksum.slice(0, 19)}…).`,
    );
    return;
  }

  // heal-frontend's eslint `header/header` rule requires the Myia
  // copyright as the FIRST block comment, written with `/***` (three
  // asterisks — its config matches the block CONTENT, which means the
  // second `*` is part of the expected content). The GENERATED notice
  // follows as the second block, then each vendored source body — each
  // with its OWN tracer-side copyright block, imports and re-exports
  // stripped, since one copyright header per file is what the lint rule
  // will accept and every symbol must be declared exactly once.
  const frontendCopyrightYear = new Date().getFullYear();
  const sourceBodyEmbedded = vendorSources
    .map(({ rel, body }) => `// ─── vendored from ${rel} ───\n\n${inlineVendorBody(body)}\n`)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  const header = `/***
 * Copyright (c) Myia 2023-${frontendCopyrightYear} - All Rights Reserved
 */

/**
 * GENERATED — do not edit by hand.
 *
 * Vendored from heal-playwright-tracer (self-contained concatenation of
 * the local-server wire-type closure):
${VENDOR_SOURCES_REL.map((rel) => ` *   ${rel}`).join('\n')}
 *
 * Source checksum: ${vendorChecksum}
 *
 * Regenerate in the heal-playwright-tracer repo:
 *   npm run gen:viewer-types
 *
 * Manual edits will be silently overwritten on the next refresh.
 */

`;
  mkdirSync(path.dirname(vendorDest), { recursive: true });
  writeFileSync(vendorDest, `${header}${sourceBodyEmbedded}\n`, 'utf8');
  console.log(
    existingChecksum
      ? `[gen:viewer-types] ✓ Vendored types updated (${existingChecksum.slice(0, 19)}… → ${vendorChecksum.slice(0, 19)}…).`
      : `[gen:viewer-types] ✓ Vendored types written (${vendorChecksum.slice(0, 19)}…).`,
  );
}

if (require.main === module) {
  genViewerTypes();
}

module.exports = { genViewerTypes, standalonePkg, healFrontend, tracerRoot };
