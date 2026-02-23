-- CreateTable
CREATE TABLE "Status" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "lastDriveUpdateTimestamp" DATETIME,
    "lastGmailUpdateTimestamp" DATETIME,
    CONSTRAINT "Status_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
