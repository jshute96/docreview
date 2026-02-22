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

export const prisma = {
  doc: mockModel(),
  label: mockModel(),
  docLabel: mockModel(),
  account: mockModel(),
  comment: mockModel(),
};
