import "server-only";

import { editAd, type EditAdInput } from "@/lib/ads/edit";
import { generateAd, type GenerateAdInput } from "@/lib/ads/generate";
import { kitTools } from "@/lib/agent/kit-tools";
import { agentInstructions } from "@/lib/agent/prompt";
import { researchTools } from "@/lib/agent/research-tools";
import { isSkillName, listSkills, loadSkill } from "@/lib/agent/skills";
import { addHeadline, deleteAd, getCampaignResearch, listAds, listHeadlines, removeHeadline } from "@/lib/campaigns";

/** What a tool call knows about itself; `toolCallId` makes paid tools idempotent across step retries. */
export type ToolCallContext = { toolCallId?: string; runId?: string };

export const AGENT_MODEL =
  process.env.AGENT_MODEL ?? process.env.RESEARCH_MODEL ?? "anthropic/claude-sonnet-5.5";

/**
 * The server side of every agent tool for one campaign, by name. The durable
 * agent (workflows/agent.ts) runs each call as its own workflow step through
 * `executeServerTool`; the pause tools (`chooseProducts`, `proposeIdeas`) have no entry because they run in
 * the browser (the choice card).
 *
 * `runId` is the agent run making the call, so research tools know whether
 * a running full research is their own run (allowed) or another (refused).
 */
export function serverTools(campaignId: string, runId?: string) {
  return {
    saveHeadline: async (input: { headline: string; cta: string }) => {
      try {
        await addHeadline(campaignId, { ...input, source: "user", proposalId: null });
        return { saved: true };
      } catch (error) {
        console.error("[agent] saveHeadline failed", error);
        return { saved: false };
      }
    },
    removeHeadline: async (input: { headline: string; cta: string }) => {
      try {
        await removeHeadline(campaignId, input);
        return { removed: true };
      } catch (error) {
        console.error("[agent] removeHeadline failed", error);
        return { removed: false };
      }
    },
    generateAd: (input: GenerateAdInput, ctx?: ToolCallContext) => generateAd(campaignId, input, ctx ?? {}),
    editAd: (input: EditAdInput, ctx?: ToolCallContext) => editAd(campaignId, input, ctx ?? {}),
    deleteAd: async ({ adId, scope }: { adId: string; scope: "version" | "ad" }) => {
      try {
        const { number, versions } = await deleteAd(campaignId, adId, scope);
        return {
          ok: true,
          summary:
            scope === "ad"
              ? `Deleted Ad ${number}${versions > 1 ? ` and its ${versions} versions` : ""}.`
              : `Deleted a version of Ad ${number}.`,
        };
      } catch (error) {
        console.error("[agent] deleteAd failed", error);
        return { ok: false, summary: "Couldn't delete that ad (it may already be gone)." };
      }
    },
    readSkill: async ({ name }: { name: string }) =>
      isSkillName(name)
        ? { ok: true, body: (await loadSkill(name)).body }
        : { ok: false, body: `No skill named "${name}".` },
    ...Object.fromEntries(
      Object.entries({ ...kitTools(campaignId), ...researchTools(campaignId, runId) }).map(([name, t]) => [
        name,
        (input: unknown) => (t.execute as (input: unknown) => Promise<unknown>)(input),
      ]),
    ),
  } as Record<string, (input: never, ctx?: ToolCallContext) => Promise<unknown>>;
}

/**
 * The agent's instructions for one run: the campaign's brand kit, saved
 * headlines and rules (lib/agent/prompt.ts), the skills it can load, and for
 * a research run the research skill itself with the order to start.
 */
export async function buildInstructions(
  campaignId: string,
  mode: "chat" | "research",
  submitted: { headline: string; cta: string }[],
): Promise<string> {
  const [research, headlines, skills, ads] = await Promise.all([
    getCampaignResearch(campaignId),
    listHeadlines(campaignId),
    listSkills(),
    listAds(campaignId),
  ]);
  if (!research) throw new Error("Campaign not found");
  const base = agentInstructions(research, headlines, submitted, skills, ads);
  if (mode === "chat") return base;
  const skill = await loadSkill("research");
  return `${base}

# Research skill (already loaded; don't call readSkill for it)

${skill.body}

# Now

Research ${research.campaign.domain} for this campaign: work through the full-run checklist above, then hand off with a short summary and chooseProducts.`;
}
