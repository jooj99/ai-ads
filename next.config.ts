import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next.js would otherwise keep writing AGENTS.md on every `next dev`;
  // the same guidance lives in CLAUDE.md instead.
  agentRules: false,
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
