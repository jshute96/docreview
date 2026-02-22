-- AlterTable
ALTER TABLE "Doc" ADD COLUMN "commentsLastSyncedAt" DATETIME;

-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "docId" TEXT NOT NULL,
    "googleCommentId" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "isMine" BOOLEAN NOT NULL DEFAULT false,
    "iParticipated" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Comment_docId_fkey" FOREIGN KEY ("docId") REFERENCES "Doc" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Comment_docId_googleCommentId_key" ON "Comment"("docId", "googleCommentId");
