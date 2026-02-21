-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Doc" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "googleDocId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "driveUrl" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'REVIEWER',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "lastModifiedInDrive" DATETIME,
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Doc_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Doc" ("addedAt", "driveUrl", "googleDocId", "id", "lastModifiedInDrive", "role", "status", "title", "userId") SELECT "addedAt", "driveUrl", "googleDocId", "id", "lastModifiedInDrive", "role", "status", "title", "userId" FROM "Doc";
DROP TABLE "Doc";
ALTER TABLE "new_Doc" RENAME TO "Doc";
CREATE UNIQUE INDEX "Doc_userId_googleDocId_key" ON "Doc"("userId", "googleDocId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
