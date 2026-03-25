import { vi } from "vitest";

function mockModel() {
  return {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
  };
}

const doc = mockModel();
const label = mockModel();
const docLabel = mockModel();
const account = mockModel();
const comment = mockModel();

export const prisma = {
  doc,
  label,
  docLabel,
  account,
  comment,
  $executeRaw: vi.fn(),
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ doc, label, docLabel, account, comment, $executeRaw: vi.fn() })),
};
