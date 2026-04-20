import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{js,ts}'],
    exclude: ['tests/integration/**', 'node_modules/**'],
    environment: 'node',
  },
});
