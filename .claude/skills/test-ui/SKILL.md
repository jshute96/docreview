---
name: test-ui
description: >
  Interactive UI testing of the Docreview app via Playwright MCP browser tools.
  Use this skill whenever the user asks to interactively test the docreview UI,
  open the browser for testing, test comments or Google Docs integration,
  do end-to-end browser testing, or verify UI behavior after code changes.
  Also triggers on /test-ui.
---

# Interactive Docreview UI Testing

You are testing the Docreview app interactively using Playwright MCP browser tools. You interact with real production Google services (Docs, Drive, Gmail), so be careful and deliberate.

$ARGUMENTS

## Safety Rules

These are production Google services. Every action you take (creating a doc, posting a comment, sending an email) is real and visible to other users.

- **Limit creation**: Create at most 1-2 documents per test session unless the user explicitly asks for more. Same for comments — don't spam.
- **Don't loop**: If an action fails, report the error and stop. Do not retry the same action repeatedly.
- **Don't modify what you didn't create**: Don't edit or delete documents that existed before this session unless explicitly told to.
- **Don't share or email** unless explicitly asked. Don't modify document permissions.
- **Track what you create**: At the end, tell the user what documents/comments were created so they can clean up if needed.

## Login

1. Read test user credentials from `testing/test_users.json` in the project root. Pick the first user.
2. Navigate to `http://localhost:3000`. It redirects to `/login`.
3. Click "Sign in with Google".
4. On the Google sign-in page, enter the `user` field value (just the username, not a full email — Google accepts it), click Next.
5. Enter the `password` field value, click Next.
6. Google may show an "unverified app" warning — click **Continue**.
7. Google shows an OAuth consent screen — click **Continue** (may appear twice).
8. You land on `http://localhost:3000/docs` — the Docreview inbox.

## Allowed Sites

Only visit these domains:

| Site | URL | Purpose |
|------|-----|---------|
| Docreview | http://localhost:3000 | Main app — doc list at /docs, comments at /comments/{id} |
| Google Docs | https://docs.google.com | View/edit documents, manage comments |
| Google Drive | https://drive.google.com | File management, sharing |
| Gmail | https://mail.google.com | Check notification emails |
| New Doc | https://doc.new | Creates a new Google Doc |

## Google Docs Actions

### Create a document
1. Open a new browser tab.
2. Navigate to `https://doc.new` — creates an untitled Google Doc.
3. Click the "Rename" textbox in the title bar, clear it, type the title.
4. Click in the document body area (`page.mouse.click(400, 500)`), then type content.

### Add text to an existing document
1. Click in the document body (`page.mouse.click(400, 500)`) to focus the iframe.
2. Press Ctrl+End to move to the end of the document.
3. Press Enter for a new line, then type.

### Select text
- **A word**: Double-click on the word (`page.mouse.dblclick(x, y)`).
- **A range**: Click at the start position, then shift-click at the end.

### Add a comment
1. Select the text you want to comment on.
2. Press Ctrl+Alt+M to open the comment dialog.
3. Type your comment text.
4. Click the "Post Comment" or "Comment" button.

### Reply to a comment
1. Click the comment in the sidebar to select it.
2. Click the Reply combobox/field.
3. Type your reply.
4. Click "Reply to comment".

### Resolve a comment
Click the comment, then click "Mark as resolved and hide discussion".

## Docreview Actions (localhost:3000)

### Doc list page (/docs)

| Action | How |
|--------|-----|
| Refresh | Click the "Refresh" button in the header.  This refreshed the doc list to find newly created or updated docs. |
| Toggle Inbox filter | Click "Inbox" button in the Filters section — toggles between inbox-only and all docs |
| Open comments page | Click a doc title link (opens in new tab — switch to it) |
| Open doc in Google | Click "Open" link on a doc row |

### Comments page (/comments/{id})

| Action | How |
|--------|-----|
| Refresh comments | Click "Refresh" button in the header |
| Expand a thread | Click the comment summary row (the row showing author and comment text) |
| Reply inline | In an expanded thread: click the "Reply..." textbox, type, click "Reply" button |
| Resolve | Click "Resolve" button in expanded thread |

## Drive Actions

- **Navigate**: Go to `https://drive.google.com`
- **Share a doc**: Open the doc in Google Docs, click the Share button

## Gmail Actions

- **Navigate**: Go to `https://mail.google.com`
- **Check notifications**: Look for sharing emails or comment notification emails in the inbox

## Tab Management

The user uses these shorthand terms:
- **"docreview tab"** or **"docs tab"** = the main doc list page at `/docs`
- **"comments tab"** = a specific doc's comments page at `/comments/{id}`
- **"Google Docs tab"** = a `docs.google.com` tab

Use `browser_tabs` to list and select tabs. Keep the number of open tabs under 5 — close tabs you no longer need.

## Playwright Tips

These are hard-won lessons from testing. Follow them to avoid common pitfalls.

**Google Docs iframe**: The document content lives inside an iframe. You cannot directly click elements in it via accessibility refs. Instead, click in the document area using coordinates (`page.mouse.click(400, 500)`) to transfer focus into the iframe, then use keyboard commands.

**Fast typing**: Use `page.keyboard.type('text')` without any `delay` option. Slow typing wastes time.

**Multi-step sequences**: Use `browser_run_code` when you need multiple actions with waits between them:
```javascript
async (page) => {
  await page.mouse.click(400, 500);
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+End');
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Your text here');
}
```

**Verify visually**: Use `browser_take_screenshot` when accessibility snapshots don't show enough detail (e.g., confirming text appeared in Google Docs).

**Sync Docreview**: After making changes in Google Docs (adding comments, editing text), they won't show up automatically in Docreview unless you do a Refresh in the docs tab, on a comments tab for a doc, or in an expanded comment thread.
For testing, we normally choose when to do these Refreshes manually so we can control and observe the state updates.

**Consent screens**: During Google login, you may encounter multiple consent/warning screens. Click "Continue" on each one — there can be 2-3 of them.
