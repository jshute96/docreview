import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Allow test instances to use a separate build directory so they don't
  // conflict with a running dev server (which locks .next/dev/lock).
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
};

export default nextConfig;
