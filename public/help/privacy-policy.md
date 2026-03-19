## Permissions

Docreview requests the following Google account permissions when you first sign in:

- **Read and write Google Drive** -- To find your documents, read comment threads, and reply to or resolve comments on your behalf.
- **Read Google Docs** -- To read suggestions (tracked changes) on documents.
- **Read Gmail** -- To detect documents shared with you via email notifications. Only emails from `drive-shares-dm-noreply@google.com` and `comments-noreply@docs.google.com` are read. No other email is accessed.

## Data storage

**Stored in the database:**
- Opaque IDs for documents and comments (not human-readable).
- Document titles.
- All metadata you enter in Docreview: labels, notes, role, status, star.

**Not stored:**
- User IDs or personal information beyond your Google display name and email.
- Document contents or text.
- Comment text or reply contents.

**Transient (browser only):**
- All other data -- comment threads, document content, suggestion text -- is fetched on demand from Google's APIs and exists only in your browser while you're viewing it.

## Authentication

Docreview uses Google OAuth for sign-in. Your access token (short-lived, ~1 hour) and refresh token (long-lived) are stored securely in the database and used only to make Google API calls on your behalf. Tokens become invalid if you revoke access through your Google account settings.

## Data sharing

Docreview does not share your data with any third parties. Your documents, comments, and metadata are visible only to you when logged in with your Google account.

## Open source

Docreview is open source. Code is at [github.com/jshute96/docreview](https://github.com/jshute96/docreview).
