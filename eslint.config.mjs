import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Git worktrees that Claude Code sessions create inside the project.
    ".claude/worktrees/**",
    // Routes Vercel Workflow generates (and gitignores) at build/dev time.
    "app/.well-known/workflow/**",
  ]),
]);

export default eslintConfig;
