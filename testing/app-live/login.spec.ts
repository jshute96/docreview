/**
 * Login bootstrap and basic verification for app-live tests.
 *
 * Run this file --headed to bootstrap auth state for the first time:
 *   scripts/run-test.sh testing/app-live/login.spec.ts --headed
 *
 * The setup project (auth.setup.ts) finds a valid session in the test DB
 * and saves it to .auth/user.json. After that, other test files can run
 * headless using the saved auth state.
 */

import { test, expect } from '@playwright/test';

test.describe('Login and basic verification', () => {
  test('doc list page shows docs', async ({ page }) => {
    await page.goto('/docs');
    await page.waitForURL('**/docs', { timeout: 15_000 });

    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 10_000 });

    const rows = table.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);
  });

  test('doc rows have title links to /comments/', async ({ page }) => {
    await page.goto('/docs');
    await page.waitForURL('**/docs', { timeout: 15_000 });

    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 10_000 });

    const titleLinks = page.locator('a[href*="/comments/"]');
    const linkCount = await titleLinks.count();
    expect(linkCount).toBeGreaterThan(0);

    // First link should have text (the doc title)
    const firstLink = titleLinks.first();
    const text = await firstLink.textContent();
    expect(text?.trim().length).toBeGreaterThan(0);
  });
});
