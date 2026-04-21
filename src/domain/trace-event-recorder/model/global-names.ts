/**
 * Copyright: (c) Myia SAS 2026.
 *   This file and its contents are licensed under the AGPLv3 License.
 *   Please see the LICENSE file at the root of this repository
 */
// Names of the global functions the Babel plugin injects into
// instrumented source and the recorder entrypoint installs on
// `globalThis`. Both sides import from here so the contract lives in
// one place.
//
// The names are deliberately prefixed with `__heal_` so anyone
// reading the Babel-transformed test source understands at a glance
// which library these hooks belong to. Rename them together (plugin
// and recorder entrypoint) if the package is ever renamed.

export const HEAL_ENTER = '__heal_enter';
export const HEAL_OK = '__heal_ok';
export const HEAL_THROW = '__heal_throw';
