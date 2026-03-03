-- Rename ACTIVE → INBOX in both doc_status and comment_status enums.
-- PostgreSQL RENAME VALUE updates the label in-place — existing rows,
-- defaults, and constraints all track the same internal OID.
ALTER TYPE "doc_status" RENAME VALUE 'ACTIVE' TO 'INBOX';
ALTER TYPE "comment_status" RENAME VALUE 'ACTIVE' TO 'INBOX';
