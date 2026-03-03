import { PrismaClient } from "@prisma/client";
import { logInfo } from "@/lib/log";
import { getRequestId } from "@/lib/request-context";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const READ_OPS = new Set([
  "findUnique", "findFirst", "findMany",
  "findRaw", "aggregate", "count", "groupBy",
]);

function makePrismaClient() {
  const client = new PrismaClient({ log: ["error", "warn"] });

  if (process.env.NODE_ENV === "development") {
    client.$use(async (params, next) => {
      // Capture request ID before await — Prisma middleware can lose AsyncLocalStorage context
      const reqId = getRequestId();
      const start = Date.now();
      const result = await next(params);
      if (!READ_OPS.has(params.action)) {
        logInfo(`[Prisma] ${params.model}.${params.action} (${Date.now() - start}ms)`, { _reqId: reqId });
      }
      return result;
    });
  }

  return client;
}

export const prisma = globalForPrisma.prisma ?? makePrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
