// Points local dev at the local Supabase (`npm run db:start` first): writes
// its URL, keys and database URL into .env.development.local, which Next and
// the npm scripts read after .env.local, so production values there are
// overridden in dev only. Run with:
//   npm run db:env
// Never prints the keys.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const out = execFileSync("npx", ["supabase@2", "status", "-o", "env"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const status = Object.fromEntries(
  out
    .split("\n")
    .map((line) => line.trim().match(/^([A-Z_]+)="?(.*?)"?$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
if (!status.API_URL) {
  console.error("The local Supabase isn't running: start it with npm run db:start.");
  process.exit(1);
}
const values = {
  SUPABASE_URL: status.API_URL,
  NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: status.PUBLISHABLE_KEY ?? status.ANON_KEY,
  SUPABASE_SECRET_KEY: status.SECRET_KEY ?? status.SERVICE_ROLE_KEY,
  POSTGRES_URL_NON_POOLING: status.DB_URL,
};
const path = ".env.development.local";
const kept = existsSync(path)
  ? readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => !(line.split("=", 1)[0].trim() in values) && !line.startsWith("# Local dev uses its own Supabase"))
  : [];
while (kept.length && !kept.at(-1).trim()) kept.pop();
const lines = [
  ...kept,
  ...(kept.length ? [""] : []),
  "# Local dev uses its own Supabase (npm run db:start), never production data.",
  ...Object.entries(values).map(([k, v]) => `${k}="${v}"`),
];
writeFileSync(path, lines.join("\n") + "\n");
console.log(`Wrote ${Object.keys(values).join(", ")} to ${path}. Restart npm run dev to pick them up.`);
