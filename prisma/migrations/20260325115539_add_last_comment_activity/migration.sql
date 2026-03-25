-- AlterTable
ALTER TABLE "docs" ADD COLUMN     "last_comment_activity" TIMESTAMP(3);

-- Backfill: initialize from the max comment timestamp or created_time_in_drive, whichever is later
UPDATE docs SET last_comment_activity = GREATEST(
  (SELECT GREATEST(MAX(drive_created_at), MAX(drive_modified_at)) FROM comments WHERE comments.doc_id = docs.doc_id),
  created_time_in_drive
);
