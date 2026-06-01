/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Static import-graph resolver. Given a spec file path and a project
// root, walks the transitive set of imported user files — relative
// imports, dynamic `import('x')` / `require('x')` with string-literal
// arguments, `export ... from '...'` — and returns them in BFS order
// with the spec marked `isEntry`.
//
// Bare specifiers (`@playwright/test`, `lodash`, etc.) resolve through
// `node_modules` and are intentionally DROPPED. The capture is
// "user source only" — node_modules and out-of-root files are never
// included. A best-effort tsconfig `paths` alias pass is applied
// before the bare-specifier drop so aliased project files
// (`@/pages/login`) still land in the graph.
//
// Parsing uses `@babel/parser`, which the tracer lists as a runtime
// dependency (small package, in the Babel ecosystem the tracer
// already lives in). We `require` it lazily and degrade gracefully —
// if the require fails for any reason, the resolver returns just the
// entry file (so capture still produces something useful instead of
// an empty manifest).

import * as fs from 'fs';
import * as path from 'path';

/** One file in the resolved graph. Forward-slash relative path, normalized. */
export interface ResolvedSourceFile {
  /** Absolute filesystem path. */
  absPath: string;
  /**
   * Project-relative path with forward slashes (e.g. `tests/foo.spec.ts`,
   * `pages/login.ts`). Always normalized to be under `rootDir`.
   */
  relPath: string;
  /** True for the entry (spec) file. */
  isEntry: boolean;
}

export interface ResolveSourceGraphOptions {
  /** Absolute project root. Files outside this are excluded. */
  rootDir: string;
  /**
   * Hard cap on the number of files in the returned graph. BFS stops
   * adding once the cap is hit. Default: 200.
   */
  maxFiles?: number;
  /**
   * Hint passed to the caller for content size policy. The resolver
   * doesn't read content (it only parses), so this is plumbed through
   * for the capture step. Kept here so config flows one place to all
   * downstream consumers. Default: 524288 (512 KB).
   */
  maxFileBytes?: number;
  /**
   * Max BFS depth. The entry file is depth 0. Default: 10. Bounded
   * so deeply-aliased monorepo graphs cannot explode the manifest.
   */
  maxDepth?: number;
  /**
   * Seam: provide a custom parser (returns specifier strings for a
   * given source text). Tests use this to avoid loading
   * `@babel/parser`. When omitted, the default lazy-loader is used.
   */
  parseSpecifiers?: ParseSpecifiers;
  /**
   * Seam: provide tsconfig data directly. When omitted, the resolver
   * reads `<rootDir>/tsconfig.json` once and parses it best-effort.
   */
  tsconfig?: TsconfigPaths;
}

export type ParseSpecifiers = (source: string, filename: string) => string[];

export interface TsconfigPaths {
  /** Absolute baseUrl. */
  baseUrl: string;
  /** `compilerOptions.paths` shape — keys may contain a single trailing `*`. */
  paths: Record<string, string[]>;
}

const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_MAX_FILE_BYTES = 524288;

const RESOLVABLE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
];

/**
 * Walk the import graph rooted at `entryAbsFile`. Returns the files in
 * BFS order with the entry file first. Never throws — any parse,
 * read, or resolve failure on an interior file is logged via the
 * `console.warn` fallback the rest of the local-viewer adapter uses
 * and the resolver continues with what it has.
 *
 * The current implementation does NOT cross into `node_modules` or
 * out-of-root files. Symlinks are followed (`fs.realpathSync.native`)
 * before the in-root check, so a symlink pointing outside the root is
 * dropped even when the link target itself appears under the root.
 */
export function resolveSourceGraph(
  entryAbsFile: string,
  options: ResolveSourceGraphOptions,
): ResolvedSourceFile[] {
  // Realpath the rootDir so symlinked temp dirs (macOS:
  // /var → /private/var) compare correctly against the realpath of
  // each resolved file path.
  const rootDir = tryRealpath(path.resolve(options.rootDir)) ?? path.resolve(options.rootDir);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const parse = options.parseSpecifiers ?? defaultParseSpecifiers;
  const tsconfig = options.tsconfig ?? loadTsconfigBestEffort(rootDir);

  const entryReal = tryRealpath(entryAbsFile);
  if (!entryReal || !isInsideRoot(entryReal, rootDir)) {
    return [];
  }

  const out: ResolvedSourceFile[] = [];
  const visited = new Set<string>();
  // BFS queue carrying (absPath, depth).
  const queue: Array<{ abs: string; depth: number }> = [{ abs: entryReal, depth: 0 }];

  while (queue.length > 0 && out.length < maxFiles) {
    const item = queue.shift();
    if (!item) break;
    const { abs, depth } = item;
    if (visited.has(abs)) continue;
    visited.add(abs);

    const rel = toForwardSlashes(path.relative(rootDir, abs));
    out.push({ absPath: abs, relPath: rel, isEntry: out.length === 0 });

    if (depth >= maxDepth) continue;
    if (out.length >= maxFiles) break;

    // Only TS/JS-like files contribute new specifiers. Skip JSON.
    const ext = path.extname(abs).toLowerCase();
    if (ext === '.json') continue;

    let source: string;
    try {
      source = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }

    let specifiers: string[];
    try {
      specifiers = parse(source, abs);
    } catch {
      continue;
    }

    const fromDir = path.dirname(abs);
    for (const spec of specifiers) {
      const resolved = resolveSpecifier(spec, fromDir, rootDir, tsconfig);
      if (!resolved) continue;
      if (visited.has(resolved)) continue;
      queue.push({ abs: resolved, depth: depth + 1 });
    }
  }

  return out;
}

export function getDefaultMaxFiles(): number {
  return DEFAULT_MAX_FILES;
}

export function getDefaultMaxFileBytes(): number {
  return DEFAULT_MAX_FILE_BYTES;
}

// ---- specifier resolution -------------------------------------------------

function resolveSpecifier(
  spec: string,
  fromDir: string,
  rootDir: string,
  tsconfig: TsconfigPaths | null,
): string | null {
  if (spec.length === 0) return null;

  // Relative / absolute.
  if (spec.startsWith('.') || path.isAbsolute(spec)) {
    const base = path.isAbsolute(spec) ? spec : path.resolve(fromDir, spec);
    return finalizeCandidate(base, rootDir);
  }

  // tsconfig path alias — best-effort.
  if (tsconfig) {
    const aliased = resolveTsconfigAlias(spec, tsconfig);
    if (aliased) {
      return finalizeCandidate(aliased, rootDir);
    }
  }

  // Bare specifier with no alias match → assume node_modules → drop.
  return null;
}

function finalizeCandidate(base: string, rootDir: string): string | null {
  const file = resolveFileVariants(base);
  if (!file) return null;
  const real = tryRealpath(file);
  if (!real) return null;
  if (!isInsideRoot(real, rootDir)) return null;
  if (isInsideNodeModules(real)) return null;
  return real;
}

function resolveFileVariants(base: string): string | null {
  // Exact path as written.
  if (isFile(base)) return base;
  // base + each extension.
  for (const ext of RESOLVABLE_EXTENSIONS) {
    const candidate = base + ext;
    if (isFile(candidate)) return candidate;
  }
  // base + /index.<ext>.
  for (const ext of RESOLVABLE_EXTENSIONS) {
    const candidate = path.join(base, 'index' + ext);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function tryRealpath(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    // Fall back to lexical normalization — symlink resolution failed
    // (e.g. file deleted between the readdir and the realpath), but
    // a sufficiently-normalized lexical path is still useful for the
    // out-of-root check.
    try {
      return path.resolve(p);
    } catch {
      return null;
    }
  }
}

function isInsideRoot(absPath: string, rootDir: string): boolean {
  const rootResolved = path.resolve(rootDir);
  return absPath === rootResolved || absPath.startsWith(rootResolved + path.sep);
}

function isInsideNodeModules(absPath: string): boolean {
  // Match `<sep>node_modules<sep>` or trailing `<sep>node_modules` —
  // any segment named exactly `node_modules`.
  const segments = absPath.split(path.sep);
  return segments.includes('node_modules');
}

function toForwardSlashes(p: string): string {
  return p.split(path.sep).join('/');
}

// ---- tsconfig path aliases (best-effort) ----------------------------------

function loadTsconfigBestEffort(rootDir: string): TsconfigPaths | null {
  const tsconfigPath = path.join(rootDir, 'tsconfig.json');
  let raw: string;
  try {
    raw = fs.readFileSync(tsconfigPath, 'utf8');
  } catch {
    return null;
  }
  let parsed: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch {
    return null;
  }
  const co = parsed.compilerOptions ?? {};
  const paths = co.paths;
  if (!paths || typeof paths !== 'object') return null;
  const baseUrl = path.resolve(rootDir, co.baseUrl ?? '.');
  return { baseUrl, paths };
}

function resolveTsconfigAlias(spec: string, tsconfig: TsconfigPaths): string | null {
  for (const [pattern, targets] of Object.entries(tsconfig.paths)) {
    if (!Array.isArray(targets) || targets.length === 0) continue;
    const match = matchAliasPattern(pattern, spec);
    if (match == null) continue;
    // Use the first target — exotic multi-target aliases pick the
    // first match.
    const target = targets[0];
    const filled = target.includes('*') ? target.replace('*', match) : target;
    return path.resolve(tsconfig.baseUrl, filled);
  }
  return null;
}

function matchAliasPattern(pattern: string, spec: string): string | null {
  const starIdx = pattern.indexOf('*');
  if (starIdx === -1) {
    return pattern === spec ? '' : null;
  }
  const head = pattern.slice(0, starIdx);
  const tail = pattern.slice(starIdx + 1);
  if (!spec.startsWith(head) || !spec.endsWith(tail)) return null;
  return spec.slice(head.length, spec.length - tail.length);
}

// Permissive comment + trailing-comma stripper. Good enough for the
// `compilerOptions.paths` field on a typical user tsconfig; not a
// general JSON-with-comments parser. Failure to strip just means
// JSON.parse fails downstream and the resolver skips path aliases.
function stripJsonComments(raw: string): string {
  let out = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/(^|\s)\/\/.*$/gm, '$1');
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return out;
}

// ---- specifier parsing (lazy @babel/parser) -------------------------------

let cachedParse: ParseSpecifiers | null | undefined;

function defaultParseSpecifiers(source: string, filename: string): string[] {
  const parse = getCachedParser();
  if (!parse) return [];
  return parse(source, filename);
}

function getCachedParser(): ParseSpecifiers | null {
  if (cachedParse !== undefined) return cachedParse;
  cachedParse = loadBabelParser();
  return cachedParse;
}

/** Visible for tests — resets the lazy parser cache. */
export function _resetParserCacheForTests(): void {
  cachedParse = undefined;
}

interface BabelParser {
  parse(code: string, options: unknown): unknown;
}

function loadBabelParser(): ParseSpecifiers | null {
  let mod: BabelParser;
  try {
    mod = require('@babel/parser') as BabelParser;
  } catch {
    return null;
  }
  return (source: string, filename: string): string[] => {
    const ext = path.extname(filename).toLowerCase();
    const isTs = ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts';
    const isJsx = ext === '.tsx' || ext === '.jsx';
    const plugins: string[] = ['decorators-legacy', 'importAttributes'];
    if (isTs) plugins.push('typescript');
    if (isJsx) plugins.push('jsx');

    let ast: unknown;
    try {
      ast = mod.parse(source, {
        sourceType: 'module',
        allowImportExportEverywhere: true,
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: true,
        allowUndeclaredExports: true,
        errorRecovery: true,
        plugins,
      });
    } catch {
      return [];
    }
    return collectSpecifiersFromAst(ast);
  };
}

interface AstNode {
  type?: string;
  source?: { type?: string; value?: unknown } | null;
  body?: unknown[];
  program?: { body?: unknown[] };
  declarations?: unknown[];
  declaration?: unknown;
  expression?: unknown;
  arguments?: unknown[];
  callee?: { type?: string; name?: string };
  init?: unknown;
  value?: unknown;
  left?: unknown;
  right?: unknown;
  consequent?: unknown;
  alternate?: unknown;
  test?: unknown;
  cases?: unknown[];
  block?: unknown;
  handler?: { body?: unknown };
  finalizer?: unknown;
  properties?: unknown[];
  elements?: unknown[];
  key?: unknown;
  argument?: unknown;
  object?: unknown;
  property?: unknown;
  params?: unknown[];
  callbacks?: unknown[];
  [key: string]: unknown;
}

function collectSpecifiersFromAst(ast: unknown): string[] {
  const found: string[] = [];
  walk(ast, found);
  return found;
}

function walk(node: unknown, found: string[]): void {
  if (!node || typeof node !== 'object') return;
  const n = node as AstNode;
  const type = n.type;

  if (typeof type === 'string') {
    switch (type) {
      case 'ImportDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration': {
        const src = n.source;
        if (src && typeof src === 'object' && (src as AstNode).type === 'StringLiteral') {
          const v = (src as AstNode).value;
          if (typeof v === 'string') found.push(v);
        }
        break;
      }
      case 'CallExpression': {
        const callee = n.callee;
        const args = Array.isArray(n.arguments) ? n.arguments : [];
        const first = args[0] as AstNode | undefined;
        if (callee && typeof callee === 'object') {
          const cn = callee as AstNode;
          // require('x') with string-literal arg.
          if (
            cn.type === 'Identifier' &&
            cn.name === 'require' &&
            first?.type === 'StringLiteral'
          ) {
            const v = first.value;
            if (typeof v === 'string') found.push(v);
          }
          // import('x') — Babel parses the callee as `Import`.
          if (cn.type === 'Import' && first?.type === 'StringLiteral') {
            const v = first.value;
            if (typeof v === 'string') found.push(v);
          }
        }
        break;
      }
    }
  }

  // Generic recursion — visit every own property that looks like a
  // node or array of nodes. Cheaper than maintaining an explicit
  // visitor table and unhurt by future AST additions (new statement
  // kinds that happen to contain imports just work).
  for (const key of Object.keys(n)) {
    if (key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue;
    const v = (n as Record<string, unknown>)[key];
    if (!v) continue;
    if (Array.isArray(v)) {
      for (const item of v) walk(item, found);
    } else if (typeof v === 'object') {
      walk(v, found);
    }
  }
}
