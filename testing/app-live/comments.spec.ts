/**
 * Tests for the comments page with live Google API access.
 *
 * Tests the full comment lifecycle: create a comment on a Google Doc via the
 * Drive API, then refresh, reply, resolve, reopen, and resolve-with-text
 * through the Docreview UI.
 *
 * Uses the first test user's OAuth tokens from the test database to create
 * comments programmatically (Playwright can't interact with Google Docs UI).
 */

import { test, expect, type Page } from '@playwright/test';
import { getTestDriveClient, createTestDriveService } from '../shared/test-drive';
import { disconnectTestDb } from '../shared/test-db';

const COMMENT_TEXT = `Testing a comment ${Date.now()}`;
const REPLY_TEXT = 'Testing a reply';
const REOPEN_TEXT = 'Reopening now';
const RESOLVE_TEXT = 'Resolving today';

/** Read the open-comments count from a doc row on the /docs page. */
async function getOpenCount(docsPage: Page, docHref: string): Promise<number> {
  const row = docsPage.locator(`a[href="${docHref}"]`).locator('xpath=ancestor::tr');
  const cell = row.locator('div[title="All unresolved comments in Google Drive"]');
  const text = await cell.textContent();
  return text?.trim() ? parseInt(text.trim(), 10) : 0;
}

/** Reload the docs page and poll until the open count matches the expected value. */
async function expectOpenCount(docsPage: Page, docHref: string, expected: number) {
  await expect.poll(async () => {
    await docsPage.reload();
    await docsPage.locator('table').waitFor({ state: 'visible', timeout: 10_000 });
    return getOpenCount(docsPage, docHref);
  }, { timeout: 15_000, message: `Expected open count to be ${expected}` }).toBe(expected);
}

test.describe('Comments page — full lifecycle', () => {
  let createdCommentId: string | undefined;
  let googleDocId: string | undefined;

  test.afterAll(async () => {
    // Clean up: resolve the test comment so it doesn't linger as open.
    // Skip if already resolved (the test's last step resolves it).
    if (createdCommentId && googleDocId) {
      try {
        const auth = await getTestDriveClient();
        const drive = createTestDriveService(auth);
        const comment = await drive.comments.get({
          fileId: googleDocId,
          commentId: createdCommentId,
          fields: 'resolved',
        });
        if (!comment.data.resolved) {
          await drive.replies.create({
            fileId: googleDocId,
            commentId: createdCommentId,
            fields: 'id',
            requestBody: { action: 'resolve' },
          });
        }
      } catch { /* best effort */ }
    }
    await disconnectTestDb();
  });

  test('add comment, reply, resolve, reopen, resolve with text', async ({ page, context }) => {
    // ── 1. Open docs page and pick a doc ──

    const docsPage = page;
    await docsPage.goto('/docs');
    const table = docsPage.locator('table');
    await expect(table).toBeVisible({ timeout: 10_000 });

    // Pick the first doc that has a title link
    const titleLink = docsPage.locator('a[href*="/comments/"]').first();
    const docHref = await titleLink.getAttribute('href');
    expect(docHref).toBeTruthy();

    // ── 2. Open comments page in a new tab ──

    const [commentsPage] = await Promise.all([
      context.waitForEvent('page'),
      titleLink.click(),
    ]);
    await commentsPage.waitForLoadState();
    expect(commentsPage.url()).toContain('/comments/');

    // ── 3. Refresh to sync any stale Drive state, then note baseline counts ──
    // Previous test runs may have resolved comments on Drive that haven't
    // been synced to the DB yet. Refreshing first ensures the DB is current.

    await commentsPage.locator('button[title="Refresh comments"]').click();
    await expect(
      commentsPage.locator('button[title="Refresh comments"] svg.animate-spin')
    ).toBeHidden({ timeout: 30_000 });

    await commentsPage.locator('button[title="Show all comments including resolved"]').click();
    const commentTable = commentsPage.locator('table');
    await expect(commentTable).toBeVisible({ timeout: 10_000 });
    const initialCommentRows = await commentTable.locator('tbody tr').count();

    // Re-read the docs page open count after the sync
    await docsPage.reload();
    await expect(docsPage.locator('table')).toBeVisible({ timeout: 10_000 });
    const baselineOpenCount = await getOpenCount(docsPage, docHref!);

    // ── 4. Get the googleDocId from the page metadata ──
    // Structure: <span><span>DocId:</span> {googleDocId}</span>
    // Get the outer span that contains "DocId:" as a child

    const docIdSpan = commentsPage.locator('span:has(> span)', { hasText: 'DocId:' });
    const docIdText = await docIdSpan.textContent();
    googleDocId = docIdText?.replace('DocId:', '').trim();
    expect(googleDocId).toBeTruthy();

    // ── 5. Add a comment via the Drive API ──

    const auth = await getTestDriveClient();
    const drive = createTestDriveService(auth);
    const createResult = await drive.comments.create({
      fileId: googleDocId!,
      fields: 'id',
      requestBody: { content: COMMENT_TEXT },
    });
    createdCommentId = createResult.data.id!;
    expect(createdCommentId).toBeTruthy();

    // ── 6. Refresh the comments page ──

    await commentsPage.locator('button[title="Refresh comments"]').click();
    // Wait for refresh to complete (spinner stops)
    await expect(
      commentsPage.locator('button[title="Refresh comments"] svg.animate-spin')
    ).toBeHidden({ timeout: 30_000 });

    // ── 7. Verify one more comment appeared, with our text ──

    // Click "All" again (refresh may reset to Inbox mode)
    await commentsPage.locator('button[title="Show all comments including resolved"]').click();

    const afterAddRows = await commentTable.locator('tbody tr').count();
    expect(afterAddRows).toBeGreaterThan(initialCommentRows);

    // Find the comment with our text
    const newComment = commentsPage.locator(`text=${COMMENT_TEXT}`);
    await expect(newComment).toBeVisible({ timeout: 5_000 });

    // ── 8. Verify docs page open count increased ──

    await expectOpenCount(docsPage, docHref!, baselineOpenCount + 1);

    // ── 9. Click the new comment to expand the thread ──

    // Find the row containing our comment text and click it
    const commentRow = commentsPage.locator('tr', { hasText: COMMENT_TEXT }).first();
    await commentRow.click();

    // The thread panel should appear with the comment text
    const threadPanel = commentsPage.locator('.rounded-lg.border.bg-zinc-50');
    await expect(threadPanel).toBeVisible({ timeout: 5_000 });
    await expect(threadPanel.locator(`text=${COMMENT_TEXT}`)).toBeVisible();

    // ── 10. Reply to the comment ──

    const replyBox = threadPanel.locator('textarea[placeholder="Reply..."]');
    await replyBox.fill(REPLY_TEXT);
    await threadPanel.locator('button[title="Reply to this comment"]').click();

    // Wait for reply to complete — the reply text appears in a thread entry (.ml-8 = reply indent)
    await expect(threadPanel.locator('.ml-8', { hasText: REPLY_TEXT })).toBeVisible({ timeout: 15_000 });

    // (Reply text appearing in the thread panel confirms the reply succeeded.)

    // ── 11. Resolve the comment ──

    await threadPanel.locator('button[title="Mark this comment as resolved"]').click();

    // "Resolved" badge appears in a reply entry in the thread
    await expect(threadPanel.locator('.ml-8 .bg-zinc-200', { hasText: 'Resolved' })).toBeVisible({ timeout: 15_000 });

    // Docs page: open count decreased by 1
    await expectOpenCount(docsPage, docHref!, baselineOpenCount);

    // ── 12. Reopen with reply text ──

    const reopenBox = threadPanel.locator('textarea[placeholder="Reply..."]');
    await reopenBox.fill(REOPEN_TEXT);
    await threadPanel.locator('button[title="Reopen this resolved comment"]').click();

    // "Reopened" badge and reopen text appear in a reply entry
    const reopenEntry = threadPanel.locator('.ml-8', { hasText: 'Reopened' });
    await expect(reopenEntry).toBeVisible({ timeout: 15_000 });
    await expect(reopenEntry.locator(`text=${REOPEN_TEXT}`)).toBeVisible();

    // Docs page: open count back up by 1
    await expectOpenCount(docsPage, docHref!, baselineOpenCount + 1);

    // ── 13. Resolve with reply text ──

    const resolveBox = threadPanel.locator('textarea[placeholder="Reply..."]');
    await resolveBox.fill(RESOLVE_TEXT);
    await threadPanel.locator('button[title="Mark this comment as resolved"]').click();

    // The last reply entry has both the "Resolved" badge and the resolve text
    const lastReply = threadPanel.locator('.ml-8').last();
    await expect(lastReply.locator('.bg-zinc-200', { hasText: 'Resolved' })).toBeVisible({ timeout: 15_000 });
    await expect(lastReply.locator(`text=${RESOLVE_TEXT}`)).toBeVisible();

    // Docs page: open count back down
    await expectOpenCount(docsPage, docHref!, baselineOpenCount);
  });
});
