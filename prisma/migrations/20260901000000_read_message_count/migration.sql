-- Replace the per-thread is_read boolean with read_message_count: the number of
-- messages in the thread the user has read, counting the head comment plus
-- replies. Fully read = reply_count + 1; 0 = nothing read.

-- AlterTable
ALTER TABLE "comments" ADD COLUMN     "read_message_count" INTEGER NOT NULL DEFAULT 0;

-- Backfill: a read thread becomes fully read (reply_count + 1); an unread
-- thread becomes fully unread (0). No partial-read signal exists to migrate.
UPDATE "comments" SET "read_message_count" = CASE WHEN "is_read" THEN "reply_count" + 1 ELSE 0 END;

-- AlterTable
ALTER TABLE "comments" DROP COLUMN "is_read";
