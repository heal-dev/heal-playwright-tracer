/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

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
