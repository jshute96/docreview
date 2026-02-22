import { vi } from "vitest";

// Suppress expected console.error output during a test block.
// Automatically restores the original implementation when done.
export async function suppressingErrors<T>(fn: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}
