import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  // Next.js would otherwise keep writing AGENTS.md on every `next dev`;
  // the same guidance lives in CLAUDE.md instead.
  agentRules: false,
  // Keep the dev-only Next.js badge off the sidebar's Settings link.
  devIndicators: { position: "bottom-right" },
  // Agent skills (SKILL.md files) are read at runtime by the agent's
  // workflow steps and the chat route.
  outputFileTracingIncludes: {
    "/api/campaigns/[id]/chat": ["./lib/agent/skills/**/*.md"],
    "/.well-known/workflow/**": ["./lib/agent/skills/**/*.md"],
  },
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

// Vercel Workflow: durable agent runs (research and chat turns) that survive
// leaving the page, timeouts and restarts. See workflows/agent.ts.
export default withWorkflow(nextConfig);
