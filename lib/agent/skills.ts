import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Agent skills: playbooks written as SKILL.md files (YAML-ish frontmatter
 * with `name` and `description`, then markdown). The agent's instructions
 * list each skill's name and description; the `readSkill` tool returns the
 * full body when the agent needs it (progressive disclosure). A run that
 * needs a skill from the start, like research, gets the body inline.
 *
 * Files are read at runtime; next.config.ts traces them into the routes
 * that use them (`outputFileTracingIncludes`).
 */

export type Skill = { name: string; description: string; body: string };

const SKILLS_DIR = path.join(process.cwd(), "lib/agent/skills");
const SKILL_NAMES = ["research", "ad-ideas"] as const;
export type SkillName = (typeof SKILL_NAMES)[number];

const cache = new Map<string, Skill>();

export async function loadSkill(name: SkillName): Promise<Skill> {
  const cached = cache.get(name);
  if (cached) return cached;
  const raw = await readFile(path.join(SKILLS_DIR, name, "SKILL.md"), "utf8");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta = Object.fromEntries(
    (match?.[1] ?? "")
      .split("\n")
      .map((line) => line.match(/^(\w+):\s*(.*)$/))
      .filter((m): m is RegExpMatchArray => Boolean(m))
      .map((m) => [m[1], m[2].trim()]),
  );
  const skill = { name: meta.name ?? name, description: meta.description ?? "", body: (match?.[2] ?? raw).trim() };
  cache.set(name, skill);
  return skill;
}

export async function listSkills(): Promise<Skill[]> {
  return Promise.all(SKILL_NAMES.map(loadSkill));
}

export function isSkillName(name: string): name is SkillName {
  return (SKILL_NAMES as readonly string[]).includes(name);
}
