import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next.js would otherwise keep writing AGENTS.md on every `next dev`;
  // the same guidance lives in CLAUDE.md instead.
  agentRules: false,
  // Keep the dev-only Next.js badge off the sidebar's Settings link.
  devIndicators: { position: "bottom-right" },
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
