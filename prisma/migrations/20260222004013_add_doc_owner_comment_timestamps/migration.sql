-- AlterTable
ALTER TABLE "Comment" ADD COLUMN "driveCreatedAt" DATETIME;
ALTER TABLE "Comment" ADD COLUMN "driveModifiedAt" DATETIME;

-- AlterTable
ALTER TABLE "Doc" ADD COLUMN "createdTimeInDrive" DATETIME;
ALTER TABLE "Doc" ADD COLUMN "owner" TEXT;
