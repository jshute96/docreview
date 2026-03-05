-- AlterTable
ALTER TABLE "comments" ADD COLUMN     "is_starred" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "docs" ADD COLUMN     "is_starred" BOOLEAN NOT NULL DEFAULT false;
