-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Label" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Label_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Label" ("color", "id", "name", "userId") SELECT "color", "id", "name", "userId" FROM "Label";
DROP TABLE "Label";
ALTER TABLE "new_Label" RENAME TO "Label";
CREATE UNIQUE INDEX "Label_userId_name_key" ON "Label"("userId", "name");

-- Backfill: assign incrementing order per user based on alphabetical name
UPDATE "Label"
SET "order" = (
  SELECT COUNT(*)
  FROM "Label" AS l2
  WHERE l2."userId" = "Label"."userId" AND l2."name" < "Label"."name"
);

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
