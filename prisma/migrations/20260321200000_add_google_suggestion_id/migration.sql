-- Add google_suggestion_id column and make google_comment_id nullable (DDL first)
ALTER TABLE "comments" ADD COLUMN "google_suggestion_id" TEXT;
ALTER TABLE "comments" ALTER COLUMN "google_comment_id" DROP NOT NULL;

-- Migrate existing suggestions: copy suggest.* IDs to new column, clear from google_comment_id
UPDATE "comments" SET "google_suggestion_id" = "google_comment_id" WHERE "type" = 'SUGGESTION';
UPDATE "comments" SET "google_comment_id" = NULL WHERE "type" = 'SUGGESTION';

-- Add unique index for suggestion ID lookups
CREATE UNIQUE INDEX "comments_doc_id_google_suggestion_id_key" ON "comments"("doc_id", "google_suggestion_id");
