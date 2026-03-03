import { PrismaClient } from "@prisma/client";
import { logInfo } from "@/lib/log";
import { getRequestId } from "@/lib/request-context";

const READ_OPS = new Set([
  "findUnique", "findFirst", "findMany",
  "findRaw", "aggregate", "count", "groupBy",
]);

// Use $extends (not the deprecated $use middleware) so the query handler runs
// in the caller's async context and AsyncLocalStorage-based request IDs
// propagate correctly.
function makePrismaClient() {
  return new PrismaClient({ log: ["error", "warn"] }).$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (process.env.NODE_ENV !== "development") return query(args);

          const reqId = getRequestId();
          const start = Date.now();
          const result = await query(args);
          if (!READ_OPS.has(operation)) {
            logInfo(`[Prisma] ${model}.${operation} (${Date.now() - start}ms)`, { _reqId: reqId });
          }
          return result;
        },
      },
    },
  });
}

const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof makePrismaClient> | undefined;
};

export const prisma = globalForPrisma.prisma ?? makePrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
