// Pure sandbox scaffolder — writes a minimal Playwright project
// that installs the tracer tarball and runs the provided spec. No
// side effects beyond file writes. The bootstrap drives this to
// set up a fresh directory per test file.
//
// The user-facing `playwright.config.ts` is intentionally bare
// (trace/video off, no browser project) so the pod-config wrapper
// has real work to do: that's what we're asserting on in the
// collector integration tests.

import * as fs from 'fs';
import * as path from 'path';

export interface SandboxContent {
  /** Absolute path to the `@heal-dev/heal-playwright-tracer` tarball. */
  tarballPath: string;
  /** Contents of the spec file that goes under `tests/collector.spec.ts`. */
  specSource: string;
}

export function scaffoldSandbox(root: string, content: SandboxContent): void {
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'heal-playwright-tracer-collector-itest',
        version: '0.0.0',
        private: true,
        devDependencies: {
          '@playwright/test': '1.58.1',
          '@heal-dev/heal-playwright-tracer': `file:${content.tarballPath}`,
        },
      },
      null,
      2,
    ),
  );

  const userConfig = `import { defineConfig } from '@playwright/test';

export default defineConfig({
  '@playwright/test': {
    babelPlugins: [
      [require.resolve('@heal-dev/heal-playwright-tracer/code-hook-injector'), { include: [/\\/tests\\//] }],
    ],
  },
  testDir: './tests',
  use: { headless: true },
} as any);
`;

  const podConfig = `import base from './playwright.config';
import { createPodConfig } from '@heal-dev/heal-playwright-tracer/pod-config';
export default createPodConfig((base as any).default ?? base);
`;

  fs.writeFileSync(path.join(root, 'playwright.config.ts'), userConfig);
  fs.writeFileSync(path.join(root, '.heal-playwright-pod.config.ts'), podConfig);
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'tests', 'collector.spec.ts'), content.specSource);
}
