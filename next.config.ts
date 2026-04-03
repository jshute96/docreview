import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Allow test instances to use a separate build directory so they don't
  // conflict with a running dev server (which locks .next/dev/lock).
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  // Rewrite multi-segment auth paths (e.g. /api/auth/callback/google) to the
  // single-segment [nextauth] route handler.  The directory was renamed from
  // [...nextauth] to [nextauth] to avoid "..." in filesystem paths.
  async rewrites() {
    return [
      {
        source: "/api/auth/:first/:rest+",
        destination: "/api/auth/:first",
      },
    ];
  },
};

export default nextConfig;
