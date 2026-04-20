// Package entry — what `import ... from '@heal-dev/heal-playwright-tracer'` hits.
//
// This file is intentionally tiny: the real wiring lives in
// ./fixture/index.ts. We re-export the Playwright surface so consumers
// can keep `import { test, expect, devices } from '@heal-dev/heal-playwright-tracer'`
// as a drop-in replacement for `@playwright/test`.

export { test, expect, snapshot, reset } from './fixture';

// Re-export every symbol from @playwright/test so code that imports
// e.g. `devices`, `chromium`, or the `Page`/`Locator` types from our
// package still gets them. The named exports above take precedence
// in module-load order.
export * from '@playwright/test';
