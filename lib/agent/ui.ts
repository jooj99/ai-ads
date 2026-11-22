import type { AgentUIMessage, CampaignCopy, ResearchToolName } from "@/lib/agent/tools";

/**
 * The few agent helpers the browser needs, apart from the tool definitions
 * in ./tools.ts. Those are the agent's server-side tooling (zod schemas and
 * the instructions the model reads for each tool); importing a value from
 * that file put all of it in the page's JavaScript. Client components import
 * from here and take only types from ./tools.ts, which compile away.
 */

/** Every research tool, by name. Checked against ./tools.ts at compile time (see below). */
const RESEARCH_TOOLS = [
  "researchStatus",
  "getCatalog",
  "detectPlatform",
  "readSite",
  "classifyOffering",
  "setOffering",
  "listSiteLinks",
  "findOfferingPages",
  "loadCatalog",
  "addProductFromLink",
  "findBrandVisuals",
  "removeProducts",
  "writeBrandInsights",
  "groupCatalog",
  "setProductTypes",
  "findPhotos",
] as const satisfies readonly ResearchToolName[];

// Fails to compile if a research tool is added in ./tools.ts and not listed above.
type Unlisted = Exclude<ResearchToolName, (typeof RESEARCH_TOOLS)[number]>;
const everyResearchTool: [Unlisted] extends [never] ? true : Unlisted = true;
void everyResearchTool;

/** Research tool part types, for rendering them as research steps in the chat. */
export const RESEARCH_TOOL_PARTS = new Set<string>(RESEARCH_TOOLS.map((name) => `tool-${name}`));

/** The tools that change the brand kit or catalog; after one runs, the page re-reads them. */
export const KIT_TOOL_PARTS = new Set<string>([
  "tool-editBrandText",
  "tool-editTags",
  "tool-editColors",
  "tool-editFonts",
  ...RESEARCH_TOOL_PARTS,
]);

/** The tools that pause the run until the user answers (no server `execute`). */
export const PAUSE_TOOLS = new Set(["chooseProducts", "proposeIdeas", "proposeHeadlines"]);

/** The question the agent is waiting on (a product pick, an idea card or an old headline card), if the thread is paused on one. */
export function pendingChoice(messages: AgentUIMessage[]) {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return null;
  for (const part of last.parts) {
    if (
      (part.type === "tool-chooseProducts" || part.type === "tool-proposeIdeas" || part.type === "tool-proposeHeadlines") &&
      part.state === "input-available"
    ) {
      return part;
    }
  }
  return null;
}

/** Whether two headline + CTA pairs are the same, ignoring case and spacing at the ends. */
export function sameCopy(a: CampaignCopy, b: CampaignCopy) {
  const norm = (s: string) => s.trim().toLowerCase();
  return norm(a.headline) === norm(b.headline) && norm(a.cta) === norm(b.cta);
}

/** The first message of every thread: what the user asked for by starting a campaign. */
export function kickoffText(domain: string) {
  return `Make ads for ${domain}`;
}
