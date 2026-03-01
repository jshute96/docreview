import { prisma } from "@/lib/prisma";

export async function getStatus(userId: string) {
  return prisma.status.findUnique({ where: { userId } });
}

export async function updateDriveChangesToken(userId: string, token: string) {
  await prisma.status.upsert({
    where: { userId },
    create: { userId, driveChangesPageToken: token },
    update: { driveChangesPageToken: token },
  });
}
