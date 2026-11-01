import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Separate build output lets `next build` run next to a live `next dev`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  transpilePackages: ["@hash8/sdk-ts", "@hash8/dcs-schema"],
  // Legacy route used by Ops Inbox links; query string is preserved.
  async redirects() {
    return [{ source: "/fleet", destination: "/inventory", permanent: false }];
  },
  experimental: {
    optimizePackageImports: ["lucide-react", "radix-ui"],
  },
};

export default nextConfig;
