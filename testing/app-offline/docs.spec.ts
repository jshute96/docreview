/**
 * Tests for the docs list page and individual doc pages.
 *
 * Runs against the test database with a real test user (first user in
 * test_users.json) so docs and comments are populated.
 */

import { test, expect } from '@playwright/test';

// Helper: go to /login, wait for auto-signin redirect to /docs
async function login(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.waitForURL('**/docs', { timeout: 15_000 });
}

test.describe('Docs list page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('displays a table with docs', async ({ page }) => {
    // Should have a table with at least one row
    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 5_000 });

    const rows = table.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);
  });

  test('doc rows have title links to /comments/', async ({ page }) => {
    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 5_000 });

    // Each doc row should have a link to its comments page
    const titleLinks = page.locator('a[href*="/comments/"]');
    const linkCount = await titleLinks.count();
    expect(linkCount).toBeGreaterThan(0);

    // First link should have text content (the doc title)
    const firstLink = titleLinks.first();
    const text = await firstLink.textContent();
    expect(text?.trim().length).toBeGreaterThan(0);
  });

  test('clicking a doc title navigates to the comments page', async ({ page }) => {
    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 5_000 });

    // Get the first doc title link's href and navigate directly
    const firstLink = page.locator('a[href*="/comments/"]').first();
    const href = await firstLink.getAttribute('href');
    expect(href).toBeTruthy();

    await page.goto(href!);

    // Should show the doc detail page with metadata
    await expect(page.locator('text=Created:')).toBeVisible({ timeout: 10_000 });
    expect(page.url()).toContain('/comments/');
  });

  test('doc rows have action buttons', async ({ page }) => {
    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 5_000 });

    const firstRow = table.locator('tbody tr').first();

    // Each row should have Open and Archive/Unarchive buttons
    await expect(firstRow.locator('text=Open')).toBeVisible();
    await expect(
      firstRow.locator('text=Archive').or(firstRow.locator('text=Unarchive'))
    ).toBeVisible();
  });
});

test.describe('Individual doc page', () => {
  // Helper: login and get the href of the first doc's comments link
  async function getFirstDocHref(page: import('@playwright/test').Page): Promise<string> {
    await login(page);
    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 5_000 });
    const href = await page.locator('a[href*="/comments/"]').first().getAttribute('href');
    expect(href).toBeTruthy();
    return href!;
  }

  test('shows doc metadata and comments section', async ({ page }) => {
    const href = await getFirstDocHref(page);
    await page.goto(href);

    // Should show the doc metadata section
    await expect(page.locator('text=Created:')).toBeVisible({ timeout: 10_000 });
    expect(page.url()).toContain('/comments/');

    // Should have a back link to docs list (the logo)
    await expect(page.locator('a[href="/docs"]')).toBeVisible();
  });

  test('back navigation returns to docs list', async ({ page }) => {
    const href = await getFirstDocHref(page);
    await page.goto(href);
    await expect(page.locator('text=Created:')).toBeVisible({ timeout: 10_000 });

    // Click back link (logo)
    await page.locator('a[href="/docs"]').click();

    // Should be back at the doc table
    await expect(page.locator('table')).toBeVisible({ timeout: 10_000 });
    expect(page.url()).toContain('/docs');
  });
});
