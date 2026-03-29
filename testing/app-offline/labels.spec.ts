/**
 * Tests for label management: creating, assigning, reordering, color changes,
 * and cancel behavior.
 *
 * Runs against the test database with the first test user in offline mode.
 * Each test verifies both the UI state and the underlying database state.
 */

import { test, expect, type Page, type Locator } from '@playwright/test';
import { getTestDb, disconnectTestDb } from '../shared/test-db';
import { getFirstTestUser } from '../shared/test-env';

const db = getTestDb();
const testUser = getFirstTestUser();
const USER_ID = testUser!.user_id;

// ---------------------------------------------------------------------------
// UI Helpers
// ---------------------------------------------------------------------------

/** Log in via offline auto-signin and wait for the docs table. */
async function loginAndWaitForTable(page: Page) {
  await page.goto('/login');
  await page.waitForURL('**/docs', { timeout: 15_000 });
  await expect(page.locator('table')).toBeVisible({ timeout: 10_000 });
}

/** Open the Manage Labels dialog from the doc-table toolbar. */
async function openManageLabels(page: Page) {
  await page.getByRole('button', { name: 'Labels' }).click();
  await expect(page.getByRole('heading', { name: 'Manage Labels' })).toBeVisible();
}

/** Type a label name and click Add inside the Manage Labels dialog. */
async function addLabel(page: Page, name: string) {
  const input = page.getByPlaceholder('Label name…');
  await input.fill(name);
  await page.locator('[role="dialog"]').getByRole('button', { name: 'Add' }).click();
  await expect(page.locator('[data-label-row]').filter({ hasText: name })).toBeVisible();
  await expect(input).toHaveValue('');
}

/** Click Save in the currently-open dialog and wait for it to close. */
async function saveDialog(page: Page) {
  const dialog = page.locator('[role="dialog"]');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).not.toBeVisible({ timeout: 10_000 });
}

/** Click Cancel in the currently-open dialog and wait for it to close. */
async function cancelDialog(page: Page) {
  const dialog = page.locator('[role="dialog"]');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).not.toBeVisible({ timeout: 5_000 });
}

/** Open the Edit dialog for a doc row (0-indexed). */
async function openEditDialog(page: Page, rowIndex: number) {
  const row = page.locator('table tbody tr').nth(rowIndex);
  await row.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('heading', { name: 'Edit Document' })).toBeVisible();
}

/** In the Edit dialog, toggle a label by clicking its name. */
async function toggleLabelInEdit(page: Page, labelName: string) {
  const dialog = page.locator('[role="dialog"]');
  await dialog.getByRole('button', { name: labelName, exact: true }).click();
}

/**
 * Get the ordered list of label badge texts displayed on a doc row.
 * Labels appear as small colored badges next to the doc title.
 */
async function getRowLabels(row: Locator): Promise<string[]> {
  // Label badges are spans with rounded-full class in the title cell (2nd td).
  // The Author badge uses `rounded` (not `rounded-full`) so it won't match.
  const badges = row.locator('td').nth(1).locator('.rounded-full.text-xs.font-medium');
  const count = await badges.count();
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const text = await badges.nth(i).textContent();
    if (text) names.push(text.trim());
  }
  return names;
}

/**
 * Get the ordered list of label names in the Manage Labels dialog.
 */
async function getDialogLabelNames(page: Page): Promise<string[]> {
  const rows = page.locator('[data-label-row]');
  const count = await rows.count();
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const text = await rows.nth(i).locator('.text-sm.text-zinc-800').textContent();
    if (text) names.push(text.trim());
  }
  return names;
}

/**
 * Get the background color of a label's color swatch in the Manage Labels dialog.
 */
async function getLabelColor(page: Page, labelName: string): Promise<string> {
  const row = page.locator('[data-label-row]').filter({ hasText: labelName });
  const swatch = row.getByRole('button', { name: `Change color for ${labelName}` });
  return await swatch.evaluate(el => el.style.backgroundColor);
}

// ---------------------------------------------------------------------------
// DB Helpers
// ---------------------------------------------------------------------------

/**
 * Get all labels for the test user, ordered by position.
 * The obscure extension decodes names in results but does NOT encode
 * `where` clause values, so we always fetch all and filter in JS.
 */
async function dbGetAllLabels() {
  return db.label.findMany({
    where: { userId: USER_ID },
    orderBy: { position: 'asc' },
    include: { _count: { select: { docs: true } } },
  });
}

/** Get a label by name for the test user. */
async function dbGetLabel(name: string) {
  const all = await dbGetAllLabels();
  return all.find(l => l.name === name) ?? null;
}

/** Get the label names attached to a doc, ordered by label position. */
async function dbGetDocLabelNames(docId: string): Promise<string[]> {
  const rows = await db.docLabel.findMany({
    where: { docId },
    include: { label: true },
    orderBy: { label: { position: 'asc' } },
  });
  return rows.map(r => r.label.name);
}

/** Get the docId for the nth visible doc row by reading the comments link href. */
async function getDocId(page: Page, rowIndex: number): Promise<string> {
  const row = page.locator('table tbody tr').nth(rowIndex);
  const href = await row.locator('a[href*="/comments/"]').first().getAttribute('href');
  // href is like /comments/<docId>
  return href!.split('/comments/')[1];
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

/** Unique prefix to avoid collisions with existing labels. */
const PREFIX = `t${Date.now()}`;
const LABEL_A = `${PREFIX}-Alpha`;
const LABEL_B = `${PREFIX}-Beta`;
const LABEL_C = `${PREFIX}-Gamma`;
const LABEL_D = `${PREFIX}-Delta`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Labels', () => {
  test.describe.configure({ mode: 'serial' });

  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await loginAndWaitForTable(page);
  });

  test.afterAll(async () => {
    // Clean up: delete the labels we created
    await openManageLabels(page);
    for (const name of [LABEL_A, LABEL_B, LABEL_C, LABEL_D]) {
      const row = page.locator('[data-label-row]').filter({ hasText: name });
      if (await row.count() > 0) {
        await row.getByRole('button', { name: `Delete ${name}` }).click();
        await page.getByRole('button', { name: 'Continue' }).click();
        await expect(row).not.toBeVisible();
      }
    }
    await saveDialog(page);
    await page.close();
    await disconnectTestDb();
  });

  test('create three labels via Manage Labels dialog', async () => {
    await openManageLabels(page);
    await addLabel(page, LABEL_A);
    await addLabel(page, LABEL_B);
    await addLabel(page, LABEL_C);
    await saveDialog(page);

    // Re-open the dialog to confirm they persisted in the UI
    await openManageLabels(page);
    const names = await getDialogLabelNames(page);
    expect(names).toContain(LABEL_A);
    expect(names).toContain(LABEL_B);
    expect(names).toContain(LABEL_C);
    await cancelDialog(page);

    // Verify database: all three labels exist with correct positions
    const dbA = await dbGetLabel(LABEL_A);
    const dbB = await dbGetLabel(LABEL_B);
    const dbC = await dbGetLabel(LABEL_C);
    expect(dbA).toBeTruthy();
    expect(dbB).toBeTruthy();
    expect(dbC).toBeTruthy();
    expect(dbA!.position).toBeLessThan(dbB!.position);
    expect(dbB!.position).toBeLessThan(dbC!.position);
  });

  test('assign labels to three docs via Edit dialog', async () => {
    // Doc 0: all three labels
    await openEditDialog(page, 0);
    await toggleLabelInEdit(page, LABEL_A);
    await toggleLabelInEdit(page, LABEL_B);
    await toggleLabelInEdit(page, LABEL_C);
    await saveDialog(page);

    // Doc 1: just Alpha
    await openEditDialog(page, 1);
    await toggleLabelInEdit(page, LABEL_A);
    await saveDialog(page);

    // Doc 2: Beta and Gamma
    await openEditDialog(page, 2);
    await toggleLabelInEdit(page, LABEL_B);
    await toggleLabelInEdit(page, LABEL_C);
    await saveDialog(page);

    // Verify UI: labels are displayed on each row
    const row0 = page.locator('table tbody tr').nth(0);
    const row1 = page.locator('table tbody tr').nth(1);
    const row2 = page.locator('table tbody tr').nth(2);

    const labels0 = await getRowLabels(row0);
    expect(labels0).toContain(LABEL_A);
    expect(labels0).toContain(LABEL_B);
    expect(labels0).toContain(LABEL_C);

    const labels1 = await getRowLabels(row1);
    expect(labels1).toContain(LABEL_A);

    const labels2 = await getRowLabels(row2);
    expect(labels2).toContain(LABEL_B);
    expect(labels2).toContain(LABEL_C);

    // Verify database: doc_labels join table has the right associations
    const docId0 = await getDocId(page, 0);
    const docId1 = await getDocId(page, 1);
    const docId2 = await getDocId(page, 2);

    const dbLabels0 = await dbGetDocLabelNames(docId0);
    expect(dbLabels0).toContain(LABEL_A);
    expect(dbLabels0).toContain(LABEL_B);
    expect(dbLabels0).toContain(LABEL_C);

    const dbLabels1 = await dbGetDocLabelNames(docId1);
    expect(dbLabels1).toContain(LABEL_A);
    expect(dbLabels1).not.toContain(LABEL_B);

    const dbLabels2 = await dbGetDocLabelNames(docId2);
    expect(dbLabels2).toContain(LABEL_B);
    expect(dbLabels2).toContain(LABEL_C);
    expect(dbLabels2).not.toContain(LABEL_A);
  });

  test('reorder labels and change color, then verify on docs page', async () => {
    await openManageLabels(page);

    // Record initial order of our test labels
    let names = await getDialogLabelNames(page);
    const aIdx = names.indexOf(LABEL_A);
    const cIdx = names.indexOf(LABEL_C);
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(cIdx).toBeGreaterThanOrEqual(0);

    // Drag LABEL_A to the position of LABEL_C (move it down)
    const rowA = page.locator('[data-label-row]').filter({ hasText: LABEL_A });
    const rowC = page.locator('[data-label-row]').filter({ hasText: LABEL_C });
    const boxA = await rowA.boundingBox();
    const boxC = await rowC.boundingBox();
    expect(boxA).toBeTruthy();
    expect(boxC).toBeTruthy();

    // Pointer-based drag: pointerdown on A, move to below C, pointerup
    await page.mouse.move(boxA!.x + boxA!.width / 2, boxA!.y + boxA!.height / 2);
    await page.mouse.down();
    await page.mouse.move(boxC!.x + boxC!.width / 2, boxC!.y + boxC!.height / 2, { steps: 10 });
    await page.mouse.up();

    // After drag, A should be after C in the dialog list
    names = await getDialogLabelNames(page);
    const newAIdx = names.indexOf(LABEL_A);
    const newCIdx = names.indexOf(LABEL_C);
    expect(newAIdx).toBeGreaterThan(newCIdx);

    // Change LABEL_B's color to red (#ef4444)
    const rowB = page.locator('[data-label-row]').filter({ hasText: LABEL_B });
    await rowB.getByRole('button', { name: `Change color for ${LABEL_B}` }).click();
    await page.getByRole('button', { name: 'Color #ef4444' }).click();

    await saveDialog(page);

    // Verify UI: row 0 label order reflects the reorder
    const row0Labels = await getRowLabels(page.locator('table tbody tr').nth(0));
    const idxA = row0Labels.indexOf(LABEL_A);
    const idxC = row0Labels.indexOf(LABEL_C);
    expect(idxA).toBeGreaterThan(idxC);

    // Verify UI: LABEL_B badge on row 0 is red
    const row0 = page.locator('table tbody tr').nth(0);
    const betaBadge = row0.locator('.rounded-full.text-xs.font-medium').filter({ hasText: LABEL_B });
    const bgColor = await betaBadge.evaluate(el => el.style.backgroundColor);
    expect(bgColor).toBe('rgb(239, 68, 68)');

    // Verify database: positions updated correctly
    const dbA = await dbGetLabel(LABEL_A);
    const dbB = await dbGetLabel(LABEL_B);
    const dbC = await dbGetLabel(LABEL_C);
    expect(dbA).toBeTruthy();
    expect(dbB).toBeTruthy();
    expect(dbC).toBeTruthy();
    // A should now have a higher position than C (moved past it)
    expect(dbA!.position).toBeGreaterThan(dbC!.position);

    // Verify database: LABEL_B color is red
    expect(dbB!.color).toBe('#ef4444');
  });

  test('cancel discards color, reorder, and new-label changes', async () => {
    // Snapshot database state before the cancel test
    const labelsBefore = await dbGetAllLabels();
    const labelBBefore = await dbGetLabel(LABEL_B);

    await openManageLabels(page);

    // Record current UI state
    const namesBefore = await getDialogLabelNames(page);
    const colorBBefore = await getLabelColor(page, LABEL_B);

    // Change LABEL_B's color to green (#22c55e)
    const rowB = page.locator('[data-label-row]').filter({ hasText: LABEL_B });
    await rowB.getByRole('button', { name: `Change color for ${LABEL_B}` }).click();
    await page.getByRole('button', { name: 'Color #22c55e' }).click();

    // Reorder: drag the last label to the top
    const lastLabel = namesBefore[namesBefore.length - 1];
    const firstLabel = namesBefore[0];
    const rowLast = page.locator('[data-label-row]').filter({ hasText: lastLabel });
    const rowFirst = page.locator('[data-label-row]').filter({ hasText: firstLabel });
    const boxLast = await rowLast.boundingBox();
    const boxFirst = await rowFirst.boundingBox();
    if (boxLast && boxFirst) {
      await page.mouse.move(boxLast.x + boxLast.width / 2, boxLast.y + boxLast.height / 2);
      await page.mouse.down();
      await page.mouse.move(boxFirst.x + boxFirst.width / 2, boxFirst.y - 5, { steps: 10 });
      await page.mouse.up();
    }

    // Add a new label
    await addLabel(page, LABEL_D);

    // Click Cancel — all changes should be discarded
    await cancelDialog(page);

    // Verify UI: Delta label is not on the docs page
    await expect(page.locator('table .rounded-full.text-xs.font-medium').filter({ hasText: LABEL_D })).not.toBeVisible();

    // Verify UI: re-open dialog shows unchanged state
    await openManageLabels(page);
    const namesAfter = await getDialogLabelNames(page);
    expect(namesAfter).not.toContain(LABEL_D);

    const testLabelsBefore = namesBefore.filter(n => n.startsWith(PREFIX));
    const testLabelsAfter = namesAfter.filter(n => n.startsWith(PREFIX));
    expect(testLabelsAfter).toEqual(testLabelsBefore);

    const colorBAfter = await getLabelColor(page, LABEL_B);
    expect(colorBAfter).toBe(colorBBefore);
    await cancelDialog(page);

    // Verify database: nothing changed
    const labelsAfter = await dbGetAllLabels();
    const testPositionsBefore = labelsBefore.filter(l => l.name.startsWith(PREFIX)).map(l => ({ name: l.name, position: l.position, color: l.color }));
    const testPositionsAfter = labelsAfter.filter(l => l.name.startsWith(PREFIX)).map(l => ({ name: l.name, position: l.position, color: l.color }));
    expect(testPositionsAfter).toEqual(testPositionsBefore);

    // Delta was never persisted
    const dbD = await dbGetLabel(LABEL_D);
    expect(dbD).toBeNull();

    // B's color is unchanged
    const labelBAfter = await dbGetLabel(LABEL_B);
    expect(labelBAfter!.color).toBe(labelBBefore!.color);
  });

  test('delete label: cancel confirm keeps it, cancel dialog keeps it on docs page', async () => {
    await openManageLabels(page);

    // LABEL_A is attached to 2 docs (row 0 and row 1)
    const rowA = page.locator('[data-label-row]').filter({ hasText: LABEL_A });
    await rowA.getByRole('button', { name: `Delete ${LABEL_A}` }).click();

    // Confirm dialog should show the doc count
    const alertDialog = page.locator('[role="alertdialog"]');
    await expect(alertDialog).toBeVisible();
    const alertText = await alertDialog.textContent();
    expect(alertText).toContain(LABEL_A);
    expect(alertText).toContain('2 documents');

    // Cancel the confirmation — label should remain in the list
    await alertDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(alertDialog).not.toBeVisible();
    await expect(rowA).toBeVisible();

    // Now try deleting LABEL_C (attached to row 0 and row 2 = 2 docs)
    const rowC = page.locator('[data-label-row]').filter({ hasText: LABEL_C });
    await rowC.getByRole('button', { name: `Delete ${LABEL_C}` }).click();

    // Verify the confirm dialog shows the correct count
    await expect(alertDialog).toBeVisible();
    const alertTextC = await alertDialog.textContent();
    expect(alertTextC).toContain(LABEL_C);
    expect(alertTextC).toContain('2 documents');

    // Confirm the delete — removes from dialog list
    await alertDialog.getByRole('button', { name: 'Continue' }).click();
    await expect(alertDialog).not.toBeVisible();
    await expect(rowC).not.toBeVisible();

    // Cancel the Manage Labels dialog — the deletion should NOT be saved
    await cancelDialog(page);

    // Verify UI: LABEL_C should still be visible (cancel discarded the delete)
    const row0Labels = await getRowLabels(page.locator('table tbody tr').nth(0));
    expect(row0Labels).toContain(LABEL_C);

    // Verify database: LABEL_C still exists with its doc associations
    const dbC = await dbGetLabel(LABEL_C);
    expect(dbC).toBeTruthy();
    expect(dbC!._count.docs).toBe(2);
  });

  test('delete label: confirm and save removes it from docs page and database', async () => {
    // Snapshot: LABEL_C's doc associations before delete
    const dbCBefore = await dbGetLabel(LABEL_C);
    expect(dbCBefore).toBeTruthy();
    expect(dbCBefore!._count.docs).toBe(2);

    await openManageLabels(page);

    // Delete LABEL_C and save this time
    const rowC = page.locator('[data-label-row]').filter({ hasText: LABEL_C });
    await rowC.getByRole('button', { name: `Delete ${LABEL_C}` }).click();

    const alertDialog = page.locator('[role="alertdialog"]');
    await expect(alertDialog).toBeVisible();
    await alertDialog.getByRole('button', { name: 'Continue' }).click();
    await expect(alertDialog).not.toBeVisible();
    await expect(rowC).not.toBeVisible();

    await saveDialog(page);

    // Verify UI: LABEL_C is gone from all doc rows
    const row0Labels = await getRowLabels(page.locator('table tbody tr').nth(0));
    expect(row0Labels).not.toContain(LABEL_C);

    const row2Labels = await getRowLabels(page.locator('table tbody tr').nth(2));
    expect(row2Labels).not.toContain(LABEL_C);

    // Verify UI: gone from the dialog too
    await openManageLabels(page);
    const names = await getDialogLabelNames(page);
    expect(names).not.toContain(LABEL_C);
    await cancelDialog(page);

    // Verify database: label is deleted
    const dbCAfter = await dbGetLabel(LABEL_C);
    expect(dbCAfter).toBeNull();

    // Verify database: doc_labels associations are also gone (cascade)
    const docId0 = await getDocId(page, 0);
    const docId2 = await getDocId(page, 2);
    const dbLabels0 = await dbGetDocLabelNames(docId0);
    expect(dbLabels0).not.toContain(LABEL_C);
    const dbLabels2 = await dbGetDocLabelNames(docId2);
    expect(dbLabels2).not.toContain(LABEL_C);
  });
});
