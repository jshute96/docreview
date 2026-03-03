-- Rename generic `id` columns to typed names.
-- PostgreSQL RENAME COLUMN automatically updates PK constraints, FK references, and indexes.

ALTER TABLE "users" RENAME COLUMN "id" TO "user_id";
ALTER TABLE "accounts" RENAME COLUMN "id" TO "account_id";
ALTER TABLE "sessions" RENAME COLUMN "id" TO "session_id";
ALTER TABLE "labels" RENAME COLUMN "id" TO "label_id";
ALTER TABLE "docs" RENAME COLUMN "id" TO "doc_id";
ALTER TABLE "comments" RENAME COLUMN "id" TO "comment_id";
