-- Add suggestion content hash column for cross-source matching
ALTER TABLE "comments" ADD COLUMN "suggestion_content_hash" TEXT;

-- Non-unique index: two suggestions in the same doc could have identical content
CREATE INDEX "comments_doc_id_suggestion_content_hash_idx" ON "comments"("doc_id", "suggestion_content_hash");
