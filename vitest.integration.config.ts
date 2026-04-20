import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    // Integration tests build + pack the package, install into a
    // sandbox via `npm install`, and spawn Playwright — all of that
    // takes tens of seconds on a cold run, so we bump every timeout
    // well past the unit-test defaults.
    testTimeout: 180_000,
    hookTimeout: 600_000,
    globalSetup: ['./tests/integration/global-setup.ts'],
    // Integration tests mutate a shared sandbox on disk; running
    // them in parallel would race the `test-results/` directory.
    fileParallelism: false,
  },
});
