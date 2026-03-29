/**
 * Smoke tests for docreview in offline mode.
 *
 * Verifies the app starts, offline auto-login works, and core pages load.
 */

import { test, expect } from '@playwright/test';

test.describe('Offline mode — smoke tests', () => {
  test('login page auto-signs in and redirects to /docs', async ({ page }) => {
    await page.goto('/login');

    // AutoSignIn component triggers signIn("offline") after 100ms,
    // which should redirect to /docs
    await page.waitForURL('**/docs', { timeout: 15_000 });

    // The doc table page should be visible
    await expect(page.locator('body')).toBeVisible();
  });

  test('/docs page loads successfully', async ({ page }) => {
    // Go to login first to establish session
    await page.goto('/login');
    await page.waitForURL('**/docs', { timeout: 15_000 });

    // On a fresh DB the welcome dialog appears; on a populated DB the doc
    // table is visible. Either way the page rendered successfully.
    const welcome = page.locator('text=Welcome to Docreview');
    const table = page.locator('table');
    await expect(welcome.or(table)).toBeVisible({ timeout: 5_000 });
  });

  test('/comments page loads', async ({ page }) => {
    // Establish session
    await page.goto('/login');
    await page.waitForURL('**/docs', { timeout: 15_000 });

    // Navigate to comments
    await page.goto('/comments');
    await expect(page.locator('body')).toBeVisible();
    // Should not redirect back to login
    expect(page.url()).toContain('/comments');
  });

  test('/add page loads', async ({ page }) => {
    await page.goto('/login');
    await page.waitForURL('**/docs', { timeout: 15_000 });

    await page.goto('/add');
    await expect(page.locator('body')).toBeVisible();
    expect(page.url()).toContain('/add');
  });

  test('unauthenticated request redirects to /login', async ({ page }) => {
    // Without signing in first, /docs should redirect to /login
    await page.goto('/docs');
    await page.waitForURL('**/login', { timeout: 10_000 });
  });
});
