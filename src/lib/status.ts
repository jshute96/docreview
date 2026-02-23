import { prisma } from "@/lib/prisma";

export async function getStatus(userId: string) {
  return prisma.status.findUnique({ where: { userId } });
}

export async function updateDriveTimestamp(userId: string, timestamp: Date) {
  await prisma.status.upsert({
    where: { userId },
    create: { userId, lastDriveUpdateTimestamp: timestamp },
    update: { lastDriveUpdateTimestamp: timestamp },
  });
}
