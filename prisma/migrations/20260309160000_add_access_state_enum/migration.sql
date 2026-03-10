-- CreateEnum
CREATE TYPE "access_state" AS ENUM ('OK', 'TRASHED', 'NOT_FOUND', 'DENIED');

-- AlterTable: add access_state column with default OK
ALTER TABLE "docs" ADD COLUMN "access_state" "access_state" NOT NULL DEFAULT 'OK';

-- Migrate data from boolean columns to enum
UPDATE "docs" SET "access_state" = 'DENIED' WHERE "permission_denied" = true;
UPDATE "docs" SET "access_state" = 'NOT_FOUND' WHERE "is_deleted" = true AND "permission_denied" = false;

-- Drop old boolean columns
ALTER TABLE "docs" DROP COLUMN "is_deleted";
ALTER TABLE "docs" DROP COLUMN "permission_denied";
