-- Rename enum types
ALTER TYPE "DocRole" RENAME TO "doc_role";
ALTER TYPE "DocStatus" RENAME TO "doc_status";
ALTER TYPE "CommentType" RENAME TO "comment_type";
ALTER TYPE "SuggestionType" RENAME TO "suggestion_type";
ALTER TYPE "CommentStatus" RENAME TO "comment_status";

-- Rename tables
ALTER TABLE "User" RENAME TO "users";
ALTER TABLE "Account" RENAME TO "accounts";
ALTER TABLE "Session" RENAME TO "sessions";
ALTER TABLE "VerificationToken" RENAME TO "verification_tokens";
ALTER TABLE "Status" RENAME TO "statuses";
ALTER TABLE "Label" RENAME TO "labels";
ALTER TABLE "Doc" RENAME TO "docs";
ALTER TABLE "Comment" RENAME TO "comments";
ALTER TABLE "DocLabel" RENAME TO "doc_labels";

-- Rename columns: users
ALTER TABLE "users" RENAME COLUMN "emailVerified" TO "email_verified";

-- Rename columns: accounts
ALTER TABLE "accounts" RENAME COLUMN "userId" TO "user_id";
ALTER TABLE "accounts" RENAME COLUMN "providerAccountId" TO "provider_account_id";

-- Rename columns: sessions
ALTER TABLE "sessions" RENAME COLUMN "sessionToken" TO "session_token";
ALTER TABLE "sessions" RENAME COLUMN "userId" TO "user_id";

-- Rename columns: statuses
ALTER TABLE "statuses" RENAME COLUMN "userId" TO "user_id";
ALTER TABLE "statuses" RENAME COLUMN "lastDriveUpdateTimestamp" TO "last_drive_update_timestamp";
ALTER TABLE "statuses" RENAME COLUMN "lastGmailUpdateTimestamp" TO "last_gmail_update_timestamp";

-- Rename columns: labels
ALTER TABLE "labels" RENAME COLUMN "userId" TO "user_id";

-- Rename columns: docs
ALTER TABLE "docs" RENAME COLUMN "userId" TO "user_id";
ALTER TABLE "docs" RENAME COLUMN "googleDocId" TO "google_doc_id";
ALTER TABLE "docs" RENAME COLUMN "driveUrl" TO "drive_url";
ALTER TABLE "docs" RENAME COLUMN "mimeType" TO "mime_type";
ALTER TABLE "docs" RENAME COLUMN "isDeleted" TO "is_deleted";
ALTER TABLE "docs" RENAME COLUMN "lastModifiedInDrive" TO "last_modified_in_drive";
ALTER TABLE "docs" RENAME COLUMN "createdTimeInDrive" TO "created_time_in_drive";
ALTER TABLE "docs" RENAME COLUMN "addedAt" TO "added_at";
ALTER TABLE "docs" RENAME COLUMN "commentsLastSyncedAt" TO "comments_last_synced_at";

-- Rename columns: comments
ALTER TABLE "comments" RENAME COLUMN "docId" TO "doc_id";
ALTER TABLE "comments" RENAME COLUMN "googleCommentId" TO "google_comment_id";
ALTER TABLE "comments" RENAME COLUMN "suggestionType" TO "suggestion_type";
ALTER TABLE "comments" RENAME COLUMN "isThreadAuthor" TO "is_thread_author";
ALTER TABLE "comments" RENAME COLUMN "iParticipated" TO "i_participated";
ALTER TABLE "comments" RENAME COLUMN "driveCreatedAt" TO "drive_created_at";
ALTER TABLE "comments" RENAME COLUMN "driveModifiedAt" TO "drive_modified_at";
ALTER TABLE "comments" RENAME COLUMN "replyCount" TO "reply_count";
ALTER TABLE "comments" RENAME COLUMN "createdAt" TO "created_at";
ALTER TABLE "comments" RENAME COLUMN "updatedAt" TO "updated_at";

-- Rename columns: doc_labels
ALTER TABLE "doc_labels" RENAME COLUMN "docId" TO "doc_id";
ALTER TABLE "doc_labels" RENAME COLUMN "labelId" TO "label_id";
