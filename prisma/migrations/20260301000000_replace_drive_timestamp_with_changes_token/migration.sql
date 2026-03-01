-- AlterTable
ALTER TABLE "statuses" DROP COLUMN "last_drive_update_timestamp",
ADD COLUMN     "drive_changes_page_token" TEXT;
