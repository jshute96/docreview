-- AlterTable
ALTER TABLE "comments" ADD COLUMN     "assigned_to_me" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mentioned_me" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mentioned_me_unreplied" BOOLEAN NOT NULL DEFAULT false;
