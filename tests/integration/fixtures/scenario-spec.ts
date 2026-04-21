// The single Playwright spec used by both integration test files
// (`scenarios-disk.test.ts` and `scenarios-http.test.ts`).
//
// Six scenarios — one per `test()` block — that exercise every branch
// the integration suite asserts on:
//
//   1. happy path click             → basic pipeline + statement.screenshot
//   2. failing assertion            → throw-event-builder + test-result.status='failed'
//   3. test step nesting            → step-tracking → stepPath on statements
//   4. variable declarations        → hoist transform + __ok({x}) + safeVars
//   5. nested helper call           → active-enter stack (depth > 0, parentSeq != null)
//   6. stdout and stderr capture    → test-stdout-capture → test-result.stdout/stderr
//
// `INTEGRATION_BASE_URL` is the static HTML page that global-setup
// serves; it's read at runtime so a single spec works regardless of
// which port the host server bound.

export const SCENARIO_SPEC = `import { test, expect, type Page } from '@playwright/test';

const base = process.env.INTEGRATION_BASE_URL as string;

async function clickHelloButton(page: Page) {
  const btn = page.locator('#hello');
  await btn.click();
}

test('happy path click', async ({ page }) => {
  await page.goto(base + '/');
  const button = page.locator('#hello');
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.locator('#status')).toHaveText('clicked');
});

test('failing assertion', async ({ page }) => {
  await page.goto(base + '/');
  expect(1 + 1).toBe(3);
});

test('test step nesting', async ({ page }) => {
  await page.goto(base + '/');
  await test.step('outer step', async () => {
    await test.step('inner step', async () => {
      await page.locator('#hello').click();
    });
  });
});

test('variable declarations', async ({ page }) => {
  await page.goto(base + '/');
  const greeting = 'hello world';
  const answer = 42;
  expect(greeting.length).toBeGreaterThan(0);
  expect(answer).toBe(42);
});

test('nested helper call', async ({ page }) => {
  await page.goto(base + '/');
  await clickHelloButton(page);
});

test('stdout and stderr capture', async ({ page }) => {
  console.log('hello from stdout');
  console.error('hello from stderr');
  await page.goto(base + '/');
});
`;
