/**
 * Tests for the docs list page with live Google data.
 *
 * Verifies that documents display with real titles fetched from Google Drive
 * (not placeholder or "Untitled" text).
 */

import { test, expect } from '@playwright/test';

test.describe('Docs list page', () => {
  test('documents show real titles', async ({ page }) => {
    await page.goto('/docs');
    await page.waitForURL('**/docs', { timeout: 15_000 });

    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 10_000 });

    // Should have at least one doc
    const titleLinks = page.locator('a[href*="/comments/"]');
    const count = await titleLinks.count();
    expect(count).toBeGreaterThan(0);

    // Every title should be non-empty and not "Untitled"
    for (let i = 0; i < count; i++) {
      const text = (await titleLinks.nth(i).textContent())?.trim();
      expect(text?.length).toBeGreaterThan(0);
      expect(text).not.toContain('Untitled');
    }
  });
});
