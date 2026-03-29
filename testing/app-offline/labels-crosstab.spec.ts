/**
 * Cross-tab label sync test.
 *
 * Verifies that when labels are modified in one tab (delete, color change,
 * add), all other open tabs/dialogs update via cross-tab broadcast:
 * - /docs page (filter bar + doc row badges)
 * - /comments/<docId> page (doc labels section)
 * - /add page (label picker)
 * - /docs with Add dialog open (label picker in dialog)
 * - /docs with Edit dialog open (label picker in dialog)
 * - /comments/<docId> with Edit dialog open (label picker in dialog)
 * - /docs with Manage Labels dialog open (label rows)
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { getTestDb, disconnectTestDb } from '../shared/test-db';
import { getFirstTestUser } from '../shared/test-env';

const db = getTestDb();
const testUser = getFirstTestUser();
const USER_ID = testUser!.user_id;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loginAndWaitForTable(page: Page) {
  await page.goto('/login');
  await page.waitForURL('**/docs', { timeout: 15_000 });
  await expect(page.locator('table')).toBeVisible({ timeout: 10_000 });
}

async function openManageLabels(page: Page) {
  await page.getByRole('button', { name: 'Labels' }).click();
  await expect(page.getByRole('heading', { name: 'Manage Labels' })).toBeVisible();
}

async function addLabel(page: Page, name: string) {
  const input = page.getByPlaceholder('Label name…');
  await input.fill(name);
  await page.locator('[role="dialog"]').getByRole('button', { name: 'Add' }).click();
  await expect(page.locator('[data-label-row]').filter({ hasText: name })).toBeVisible();
  await expect(input).toHaveValue('');
}

async function saveDialog(page: Page) {
  const dialog = page.locator('[role="dialog"]');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).not.toBeVisible({ timeout: 10_000 });
}

async function cancelDialog(page: Page) {
  const dialog = page.locator('[role="dialog"]');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).not.toBeVisible({ timeout: 5_000 });
}

/** Get the docId from the nth doc row's comments link. */
async function getDocId(page: Page, rowIndex: number): Promise<string> {
  const row = page.locator('table tbody tr').nth(rowIndex);
  const href = await row.locator('a[href*="/comments/"]').first().getAttribute('href');
  return href!.split('/comments/')[1];
}

/** DB helper: get all labels for the test user. */
async function dbGetAllLabels() {
  return db.label.findMany({
    where: { userId: USER_ID },
    orderBy: { position: 'asc' },
    include: { _count: { select: { docs: true } } },
  });
}

async function dbGetLabel(name: string) {
  const all = await dbGetAllLabels();
  return all.find(l => l.name === name) ?? null;
}

// ---------------------------------------------------------------------------
// Label names
// ---------------------------------------------------------------------------

const PREFIX = `xt${Date.now()}`;
const LABEL_1 = `${PREFIX}-One`;
const LABEL_2 = `${PREFIX}-Two`;
const LABEL_3 = `${PREFIX}-Three`;

const GREEN = '#22c55e';
const RED = '#ef4444';
const PURPLE = '#8b5cf6';

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test.describe('Labels cross-tab sync', () => {
  let context: BrowserContext;
  let setupPage: Page;
  let docId: string;

  // Pages we'll verify
  let tabDocs: Page;
  let tabComments: Page;
  let tabAdd: Page;
  let tabDocsAddDialog: Page;
  let tabDocsEditDialog: Page;
  let tabCommentsEditDialog: Page;
  let tabDocsManageLabels: Page;
  let tabAction: Page; // the tab that makes the changes

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();

    // --- Setup: create labels and assign to a doc ---
    setupPage = await context.newPage();
    await loginAndWaitForTable(setupPage);
    docId = await getDocId(setupPage, 0);

    // Create LABEL_1 (green) and LABEL_2 (red)
    await openManageLabels(setupPage);
    await addLabel(setupPage, LABEL_1);
    await addLabel(setupPage, LABEL_2);

    // Set LABEL_1 to green
    const row1 = setupPage.locator('[data-label-row]').filter({ hasText: LABEL_1 });
    await row1.getByRole('button', { name: `Change color for ${LABEL_1}` }).click();
    await setupPage.getByRole('button', { name: `Color ${GREEN}` }).click();

    // Set LABEL_2 to red
    const row2 = setupPage.locator('[data-label-row]').filter({ hasText: LABEL_2 });
    await row2.getByRole('button', { name: `Change color for ${LABEL_2}` }).click();
    await setupPage.getByRole('button', { name: `Color ${RED}` }).click();

    await saveDialog(setupPage);

    // Assign both labels to doc 0 via Edit dialog
    const docRow = setupPage.locator('table tbody tr').nth(0);
    await docRow.getByRole('button', { name: 'Edit' }).click();
    await expect(setupPage.getByRole('heading', { name: 'Edit Document' })).toBeVisible();
    const dialog = setupPage.locator('[role="dialog"]');
    await dialog.getByRole('button', { name: LABEL_1, exact: true }).click();
    await dialog.getByRole('button', { name: LABEL_2, exact: true }).click();
    await saveDialog(setupPage);

    // Verify labels on the doc row
    const badges = docRow.locator('td').nth(1).locator('.rounded-full.text-xs.font-medium');
    await expect(badges.filter({ hasText: LABEL_1 })).toBeVisible();
    await expect(badges.filter({ hasText: LABEL_2 })).toBeVisible();

    await setupPage.close();
  });

  test.afterAll(async () => {
    // Clean up labels
    const cleanupPage = await context.newPage();
    await loginAndWaitForTable(cleanupPage);
    await openManageLabels(cleanupPage);
    for (const name of [LABEL_1, LABEL_2, LABEL_3]) {
      const row = cleanupPage.locator('[data-label-row]').filter({ hasText: name });
      if (await row.count() > 0) {
        await row.getByRole('button', { name: `Delete ${name}` }).click();
        await cleanupPage.getByRole('button', { name: 'Continue' }).click();
        await expect(row).not.toBeVisible();
      }
    }
    await saveDialog(cleanupPage);
    await cleanupPage.close();
    await context.close();
    await disconnectTestDb();
  });

  test('label changes broadcast to all open tabs', async () => {
    // ---------------------------------------------------------------
    // Open all tabs that display labels
    // ---------------------------------------------------------------

    // Tab 1: /docs page
    tabDocs = await context.newPage();
    await loginAndWaitForTable(tabDocs);

    // Tab 2: /comments/<docId>
    tabComments = await context.newPage();
    await tabComments.goto('/login');
    await tabComments.waitForURL('**/docs', { timeout: 15_000 });
    await tabComments.goto(`/comments/${docId}`);
    await expect(tabComments.locator('text=Labels:')).toBeVisible({ timeout: 10_000 });

    // Tab 3: /add page
    tabAdd = await context.newPage();
    await tabAdd.goto('/login');
    await tabAdd.waitForURL('**/docs', { timeout: 15_000 });
    await tabAdd.goto('/add');
    await expect(tabAdd.locator('text=Labels')).toBeVisible({ timeout: 10_000 });

    // Tab 4: /docs with Add dialog open
    tabDocsAddDialog = await context.newPage();
    await loginAndWaitForTable(tabDocsAddDialog);
    await tabDocsAddDialog.getByRole('button', { name: 'Add doc' }).click();
    await expect(tabDocsAddDialog.getByRole('heading', { name: /add/i })).toBeVisible();

    // Tab 5: /docs with Edit dialog open for doc 0
    tabDocsEditDialog = await context.newPage();
    await loginAndWaitForTable(tabDocsEditDialog);
    await tabDocsEditDialog.locator('table tbody tr').nth(0).getByRole('button', { name: 'Edit' }).click();
    await expect(tabDocsEditDialog.getByRole('heading', { name: 'Edit Document' })).toBeVisible();

    // Tab 6: /comments/<docId> with Edit dialog open
    tabCommentsEditDialog = await context.newPage();
    await tabCommentsEditDialog.goto('/login');
    await tabCommentsEditDialog.waitForURL('**/docs', { timeout: 15_000 });
    await tabCommentsEditDialog.goto(`/comments/${docId}`);
    await expect(tabCommentsEditDialog.locator('text=Labels:')).toBeVisible({ timeout: 10_000 });
    // The Edit button next to Labels: has title="Edit document labels and notes"
    await tabCommentsEditDialog.locator('button[title="Edit document labels and notes"]').click();
    await expect(tabCommentsEditDialog.getByRole('heading', { name: 'Edit Document' })).toBeVisible({ timeout: 5_000 });

    // Tab 7: /docs with Manage Labels dialog open
    tabDocsManageLabels = await context.newPage();
    await loginAndWaitForTable(tabDocsManageLabels);
    await openManageLabels(tabDocsManageLabels);

    // ---------------------------------------------------------------
    // Verify all tabs show labels before changes
    // ---------------------------------------------------------------

    // Docs page: filter bar should have both labels
    await expect(tabDocs.getByRole('button', { name: LABEL_1, exact: true })).toBeVisible();
    await expect(tabDocs.getByRole('button', { name: LABEL_2, exact: true })).toBeVisible();

    // ---------------------------------------------------------------
    // Make changes in a separate action tab
    // ---------------------------------------------------------------

    tabAction = await context.newPage();
    await loginAndWaitForTable(tabAction);
    await openManageLabels(tabAction);

    // Delete LABEL_1
    const actionRow1 = tabAction.locator('[data-label-row]').filter({ hasText: LABEL_1 });
    await actionRow1.getByRole('button', { name: `Delete ${LABEL_1}` }).click();
    const alertDialog = tabAction.locator('[role="alertdialog"]');
    await expect(alertDialog).toBeVisible();
    const alertText = await alertDialog.textContent();
    expect(alertText).toContain('1 document');
    await alertDialog.getByRole('button', { name: 'Continue' }).click();

    // Change LABEL_2 color to purple
    const actionRow2 = tabAction.locator('[data-label-row]').filter({ hasText: LABEL_2 });
    await actionRow2.getByRole('button', { name: `Change color for ${LABEL_2}` }).click();
    await tabAction.getByRole('button', { name: `Color ${PURPLE}` }).click();

    // Add LABEL_3
    await addLabel(tabAction, LABEL_3);

    // Save — this triggers the cross-tab broadcast
    await saveDialog(tabAction);

    // Brief pause to let cross-tab events start propagating before we poll
    await tabAction.waitForTimeout(250);

    // ---------------------------------------------------------------
    // Verify: /docs page (Tab 1)
    // Filter bar: LABEL_1 gone, LABEL_2 present, LABEL_3 appeared
    // ---------------------------------------------------------------
    await expect(tabDocs.getByRole('button', { name: LABEL_1, exact: true })).not.toBeVisible({ timeout: 5_000 });
    await expect(tabDocs.getByRole('button', { name: LABEL_2, exact: true })).toBeVisible();
    await expect(tabDocs.getByRole('button', { name: LABEL_3, exact: true })).toBeVisible();

    // Doc row 0 badges: LABEL_1 gone, LABEL_2 present with purple color
    const docsRow0 = tabDocs.locator('table tbody tr').nth(0);
    const docsBadges = docsRow0.locator('td').nth(1).locator('.rounded-full.text-xs.font-medium');
    await expect(docsBadges.filter({ hasText: LABEL_1 })).not.toBeVisible();
    await expect(docsBadges.filter({ hasText: LABEL_2 })).toBeVisible();
    const label2BadgeBg = await docsBadges.filter({ hasText: LABEL_2 }).evaluate(
      el => el.style.backgroundColor
    );
    // #8b5cf6 = rgb(139, 92, 246)
    expect(label2BadgeBg).toBe('rgb(139, 92, 246)');

    // ---------------------------------------------------------------
    // Verify: /comments/<docId> page (Tab 2)
    // Doc labels section: LABEL_1 gone, LABEL_2 present with purple
    // ---------------------------------------------------------------
    const commentsLabels = tabComments.locator('.rounded-full.text-xs.font-medium');
    await expect(commentsLabels.filter({ hasText: LABEL_1 })).not.toBeVisible({ timeout: 5_000 });
    await expect(commentsLabels.filter({ hasText: LABEL_2 })).toBeVisible();
    const commentsLabel2Bg = await commentsLabels.filter({ hasText: LABEL_2 }).evaluate(
      el => el.style.backgroundColor
    );
    expect(commentsLabel2Bg).toBe('rgb(139, 92, 246)');

    // ---------------------------------------------------------------
    // Verify: /add page (Tab 3)
    // Label picker: LABEL_1 gone, LABEL_2 present, LABEL_3 appeared
    // ---------------------------------------------------------------
    await expect(tabAdd.getByRole('button', { name: LABEL_1, exact: true })).not.toBeVisible({ timeout: 5_000 });
    await expect(tabAdd.getByRole('button', { name: LABEL_2, exact: true })).toBeVisible();
    await expect(tabAdd.getByRole('button', { name: LABEL_3, exact: true })).toBeVisible();

    // LABEL_2 should be purple
    const addLabel2 = tabAdd.getByRole('button', { name: LABEL_2, exact: true });
    const addLabel2Bg = await addLabel2.evaluate(el => el.style.backgroundColor);
    expect(addLabel2Bg).toBe('rgb(139, 92, 246)');

    // ---------------------------------------------------------------
    // Verify: /docs + Add dialog (Tab 4)
    // Label picker in dialog: LABEL_1 gone, LABEL_2 present, LABEL_3 appeared
    // ---------------------------------------------------------------
    const addDialogContent = tabDocsAddDialog.locator('[role="dialog"]');
    await expect(addDialogContent.getByRole('button', { name: LABEL_1, exact: true })).not.toBeVisible({ timeout: 5_000 });
    await expect(addDialogContent.getByRole('button', { name: LABEL_2, exact: true })).toBeVisible();
    await expect(addDialogContent.getByRole('button', { name: LABEL_3, exact: true })).toBeVisible();

    // ---------------------------------------------------------------
    // Verify: /docs + Edit dialog (Tab 5)
    // Label picker in dialog: LABEL_1 gone, LABEL_2 present, LABEL_3 appeared
    // ---------------------------------------------------------------
    const editDialogContent = tabDocsEditDialog.locator('[role="dialog"]');
    await expect(editDialogContent.getByRole('button', { name: LABEL_1, exact: true })).not.toBeVisible({ timeout: 5_000 });
    await expect(editDialogContent.getByRole('button', { name: LABEL_2, exact: true })).toBeVisible();
    await expect(editDialogContent.getByRole('button', { name: LABEL_3, exact: true })).toBeVisible();

    // LABEL_2 in Edit dialog should be purple
    const editLabel2 = editDialogContent.getByRole('button', { name: LABEL_2, exact: true });
    const editLabel2Bg = await editLabel2.evaluate(el => el.style.backgroundColor);
    expect(editLabel2Bg).toBe('rgb(139, 92, 246)');

    // ---------------------------------------------------------------
    // Verify: /comments/<docId> + Edit dialog (Tab 6)
    // Label picker: LABEL_1 gone, LABEL_2 present, LABEL_3 appeared
    // ---------------------------------------------------------------
    const commentsEditDialog = tabCommentsEditDialog.locator('[role="dialog"]');
    await expect(commentsEditDialog.getByRole('button', { name: LABEL_1, exact: true })).not.toBeVisible({ timeout: 5_000 });
    await expect(commentsEditDialog.getByRole('button', { name: LABEL_2, exact: true })).toBeVisible();
    await expect(commentsEditDialog.getByRole('button', { name: LABEL_3, exact: true })).toBeVisible();

    // ---------------------------------------------------------------
    // Verify: /docs + Manage Labels dialog (Tab 7)
    // The Manage Labels dialog uses buffered draft state, so it won't
    // auto-update from cross-tab events. But the underlying label
    // context on the page does update. When the user cancels and
    // reopens the dialog, it should show the new state.
    // ---------------------------------------------------------------
    await cancelDialog(tabDocsManageLabels);
    await openManageLabels(tabDocsManageLabels);

    const mlRows = tabDocsManageLabels.locator('[data-label-row]');
    await expect(mlRows.filter({ hasText: LABEL_1 })).not.toBeVisible({ timeout: 5_000 });
    await expect(mlRows.filter({ hasText: LABEL_2 })).toBeVisible();
    await expect(mlRows.filter({ hasText: LABEL_3 })).toBeVisible();

    // Verify LABEL_2 color swatch is purple
    const mlLabel2Swatch = mlRows.filter({ hasText: LABEL_2 }).getByRole('button', { name: `Change color for ${LABEL_2}` });
    const mlLabel2Bg = await mlLabel2Swatch.evaluate(el => el.style.backgroundColor);
    expect(mlLabel2Bg).toBe('rgb(139, 92, 246)');

    await cancelDialog(tabDocsManageLabels);

    // ---------------------------------------------------------------
    // Verify database matches
    // ---------------------------------------------------------------
    const dbLabel1 = await dbGetLabel(LABEL_1);
    expect(dbLabel1).toBeNull();

    const dbLabel2 = await dbGetLabel(LABEL_2);
    expect(dbLabel2).toBeTruthy();
    expect(dbLabel2!.color).toBe(PURPLE);

    const dbLabel3 = await dbGetLabel(LABEL_3);
    expect(dbLabel3).toBeTruthy();

    // ---------------------------------------------------------------
    // Close all tabs
    // ---------------------------------------------------------------
    for (const tab of [tabDocs, tabComments, tabAdd, tabDocsAddDialog,
      tabDocsEditDialog, tabCommentsEditDialog, tabDocsManageLabels, tabAction]) {
      await tab.close();
    }
  });
});
