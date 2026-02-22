-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Comment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "docId" TEXT NOT NULL,
    "googleCommentId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'COMMENT',
    "suggestionType" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "isMine" BOOLEAN NOT NULL DEFAULT false,
    "iParticipated" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "driveCreatedAt" DATETIME,
    "driveModifiedAt" DATETIME,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Comment_docId_fkey" FOREIGN KEY ("docId") REFERENCES "Doc" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Comment" ("createdAt", "docId", "driveCreatedAt", "driveModifiedAt", "googleCommentId", "iParticipated", "id", "isMine", "replyCount", "resolved", "status", "updatedAt") SELECT "createdAt", "docId", "driveCreatedAt", "driveModifiedAt", "googleCommentId", "iParticipated", "id", "isMine", "replyCount", "resolved", "status", "updatedAt" FROM "Comment";
DROP TABLE "Comment";
ALTER TABLE "new_Comment" RENAME TO "Comment";
CREATE UNIQUE INDEX "Comment_docId_googleCommentId_key" ON "Comment"("docId", "googleCommentId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
