#!/usr/bin/env node
/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Entry point wired in package.json `bin`. Kept minimal so the Commander
// adapter remains test-driven and import-only.

import { CommanderCliAdapter } from '../application/commander-cli-adapter/commander-cli-adapter';

const adapter = new CommanderCliAdapter();
adapter.parse().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
