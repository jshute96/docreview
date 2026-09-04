-- Move the read *boundary* from live-message positions to slot positions.
--
-- A thread's slots are the head comment plus every reply slot Drive has ever
-- returned, deleted replies included (Drive keeps a tombstone for each, in its
-- original position, with content and author stripped). Slot positions are
-- monotonic and stable, so the boundary no longer slides when a reply is
-- deleted, and new replies can't hide behind a delete that lands in the same
-- sync window. See docs/comment-tracking.md.
--
-- `read_message_count` keeps its name and its meaning — how many of the live
-- messages have been read. It becomes a cache of the new slot boundary rather
-- than the authoritative value, so its existing rows need no backfill.

-- AlterTable
ALTER TABLE "comments" ADD COLUMN     "reply_slot_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "comments" ADD COLUMN     "read_slot_count"  INTEGER NOT NULL DEFAULT 0;

-- Backfill both new columns from the live counts, which is exact for every
-- thread that has never had a reply deleted.
--
-- Threads that HAVE had one are deliberately left slightly wrong: reply_slot_count
-- comes out lower than the true slot count, so the first sync after this
-- migration sees it jump and reads that as new replies, marking those threads
-- unread and moving them to INBOX (which can also unarchive their doc, and can
-- pull a muted thread out of MUTED if an already-seen reply mentions the user).
--
-- That error is one-directional and self-correcting: the backfilled value is
-- always <= the true slot count, so a real reply arriving during the migration
-- window still pushes the count strictly higher and is detected normally. No
-- message can be lost, and each thread settles permanently after one sync.
-- Accepted deliberately over an adoption branch in the sync code, since it
-- affects only threads with deleted replies — about five of them here.
UPDATE "comments" SET
  "reply_slot_count" = "reply_count",
  "read_slot_count"  = "read_message_count";
