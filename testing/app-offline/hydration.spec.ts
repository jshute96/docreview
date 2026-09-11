/**
 * Regression tests for SSR/hydration mismatches (github issue #22).
 *
 * Friendly dates are formatted relative to "now", so a server render and a
 * client hydration on opposite sides of midnight produce different text. That
 * used to fail hydration, making React re-render the whole tree in the browser —
 * which in turn broke the pre-hydration inline <script> tags on these pages.
 */

import { test, expect, type Page } from '@playwright/test';

/** The 2s fallback in HideUntilTitles must not be what satisfies an assertion. */
const BEFORE_FALLBACK = 1_500;

/**
 * Collect React rendering errors from the console. Failed network requests are
 * ignored: in offline mode the Drive-backed metadata route legitimately fails.
 */
function collectRenderErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    const text = m.text();
    if (m.type() === 'error' && !text.startsWith('Failed to load resource')) {
      errors.push(text.slice(0, 300));
    }
  });
  return errors;
}

async function login(page: Page) {
  await page.goto('/login');
  await page.waitForURL('**/docs', { timeout: 15_000 });
  await expect(page.locator('table')).toBeVisible({ timeout: 5_000 });
}

/**
 * Pick a doc whose activity date the server rendered in full `YYYY-MM-DD` form
 * (i.e. older than 6 days), and return that date. Pinning the browser clock to
 * it makes the client consider that doc "today" and format it as `HH:MM`, so
 * the server and client renders are guaranteed to disagree — which is the
 * condition this whole suite exists to exercise. Derived from the data rather
 * than hardcoded so the tests can't silently go vacuous as the test DB ages.
 */
async function findOldDocDate(page: Page): Promise<string> {
  const dates = await page.locator('td', { hasText: /^\d{4}-\d{2}-\d{2}$/ }).allInnerTexts();
  expect(
    dates,
    'no doc in the test database has an activity date older than 6 days, so the ' +
      'server/client date disagreement under test cannot be produced — reseed docreview_test'
  ).not.toHaveLength(0);
  return dates.sort().at(-1)!;
}

test.describe('Hydration', () => {
  test('doc list: client clock disagreeing with the server does not break rendering', async ({ page }) => {
    await login(page);
    const oldDate = await findOldDocDate(page);

    const errors = collectRenderErrors(page);
    // Noon-ish Pacific on the day of that doc's activity, whether or not DST applies.
    await page.clock.setFixedTime(new Date(`${oldDate}T20:00:00Z`));
    await page.goto('/docs');

    // The hook must reveal the page; the script's 2s fallback must not be what does it.
    await expect(page.locator('#hide-until-titles')).toHaveCount(0, { timeout: BEFORE_FALLBACK });
    await expect(page.locator('body')).toBeVisible({ timeout: BEFORE_FALLBACK });

    // suppressHydrationWarning keeps the server's text rather than repairing it,
    // so the full date stays on screen even though the client's clock would now
    // format that same timestamp as HH:MM.
    await expect(page.locator('td', { hasText: new RegExp(`^${oldDate}$`) }).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('doc detail: client clock disagreeing with the server does not break rendering', async ({ page }) => {
    await login(page);
    const oldDate = await findOldDocDate(page);
    const href = await page.locator('a[href*="/comments/"]').first().getAttribute('href');
    expect(href).toBeTruthy();

    const errors = collectRenderErrors(page);
    await page.clock.setFixedTime(new Date(`${oldDate}T20:00:00Z`));
    await page.goto(href!);

    await expect(page.locator('#hide-until-titles')).toHaveCount(0, { timeout: BEFORE_FALLBACK });
    await expect(page.locator('body')).toBeVisible({ timeout: BEFORE_FALLBACK });
    expect(errors).toEqual([]);
  });

  test('the body-hiding script is sent only for a real page load, not an RSC fetch', async ({ page }) => {
    await login(page);

    // A document request gets the script: it has to run before React hydrates.
    const document = await page.request.get('/docs', { headers: { 'sec-fetch-dest': 'document' } });
    expect(await document.text()).toContain('hide-until-titles');

    // A client-side navigation or prefetch fetches an RSC payload instead. React
    // would mount that tree in the browser, where an inline <script> never runs
    // (React 19 logs an error), so it must not be there.
    const rsc = await page.request.get('/docs', { headers: { 'sec-fetch-dest': 'empty', rsc: '1' } });
    expect(await rsc.text()).not.toContain('hide-until-titles');
  });
});
