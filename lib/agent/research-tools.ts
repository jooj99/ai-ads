import "server-only";

import { researchToolSpecs } from "@/lib/agent/tools";
import { getCampaign } from "@/lib/campaigns";
import { firecrawlClient } from "@/lib/research/page";
import { ResearchSession, type Actor } from "@/lib/research/state";
import * as steps from "@/lib/research/steps";
import { StepPrerequisiteError, type StepContext, type StepResult } from "@/lib/research/steps";

/** A full run that hasn't saved progress for this long is dead (claim_research uses the same rule). */
const STALE_MS = 5 * 60_000;

/**
 * The research steps as agent tools for one campaign. Steps run as research
 * (they keep the user's and agent's edits unless `force`); the tools where
 * the agent decides directly (setOffering, setProductTypes, removeProducts)
 * run as the agent, so their results count as edits research won't undo.
 *
 * Each call opens a fresh session (reads the saved kit and catalog), so
 * several tools in one turn build on each other. Errors never throw into the
 * model loop: a missing prerequisite comes back as its message ("call
 * readSite first"), anything else as a short failure the agent can report.
 */
export function researchTools(campaignId: string, runId?: string) {
  const fc = firecrawlClient();

  async function run(
    by: Actor | ((during: { researchRun: boolean }) => Actor),
    force: boolean | undefined,
    work: (ctx: StepContext) => Promise<StepResult> | StepResult,
  ): Promise<StepResult> {
    const campaign = await getCampaign(campaignId);
    const started = campaign?.researchStartedAt ? new Date(campaign.researchStartedAt).getTime() : 0;
    // A running full research refuses other callers, but not its own steps.
    const ownRun = Boolean(runId) && campaign?.agentRunId === runId;
    if (campaign?.status === "researching" && !ownRun && Date.now() - started < STALE_MS) {
      return { ok: false, summary: "A full research run is in progress; wait for it to finish before changing research." };
    }
    try {
      const actor = typeof by === "function" ? by({ researchRun: campaign?.status === "researching" && ownRun }) : by;
      const session = await ResearchSession.open(campaignId, { by: actor, force: Boolean(force) });
      return await work({ session, fc });
    } catch (error) {
      if (error instanceof StepPrerequisiteError) return { ok: false, summary: error.message };
      console.error("[agent] research tool failed", error);
      return { ok: false, summary: "That research step failed unexpectedly. Try again, or try another way." };
    }
  }

  const t = researchToolSpecs;
  return {
    researchStatus: { ...t.researchStatus, execute: () => run("research", false, (c) => steps.researchStatus(c)) },
    getCatalog: { ...t.getCatalog, execute: (input: Parameters<typeof steps.getCatalog>[1]) => run("research", false, (c) => steps.getCatalog(c, input)) },
    detectPlatform: { ...t.detectPlatform, execute: () => run("research", false, (c) => steps.detectPlatform(c)) },
    readSite: {
      ...t.readSite,
      execute: ({ force, ...input }: { url?: string; fields?: steps.BrandField[]; force?: boolean }) =>
        run("research", force, (c) => steps.readSite(c, input)),
    },
    classifyOffering: {
      ...t.classifyOffering,
      execute: (input: { guidance?: string }) => run("research", false, (c) => steps.classifyOffering(c, input)),
    },
    setOffering: {
      ...t.setOffering,
      execute: (input: { offering: "goods" | "services"; reason: string }) =>
        run("agent", false, (c) => steps.setOffering(c, input)),
    },
    listSiteLinks: { ...t.listSiteLinks, execute: () => run("research", false, (c) => steps.listSiteLinks(c)) },
    findOfferingPages: {
      ...t.findOfferingPages,
      execute: (input: { guidance?: string }) => run("research", false, (c) => steps.findOfferingPages(c, input)),
    },
    loadCatalog: {
      ...t.loadCatalog,
      // Items added on the user's request in chat count as the agent's: they
      // show as added and survive research re-runs. A full research run's
      // own loads (replace or add) stay research's.
      execute: (input: { from: "shopify" | "pages"; urls?: string[]; mode?: "add" | "replace" }) =>
        run(
          ({ researchRun }) => (input.mode === "add" && !researchRun ? "agent" : "research"),
          false,
          (c) => steps.loadCatalog(c, input),
        ),
    },
    removeProducts: {
      ...t.removeProducts,
      execute: (input: { ids: string[] }) => run("agent", false, (c) => steps.removeProducts(c, input)),
    },
    writeBrandInsights: {
      ...t.writeBrandInsights,
      execute: ({ force, ...input }: { guidance?: string; force?: boolean }) =>
        run("research", force, (c) => steps.writeBrandInsights(c, input)),
    },
    groupCatalog: {
      ...t.groupCatalog,
      execute: ({ force, ...input }: { guidance?: string; force?: boolean }) =>
        run("research", force, (c) => steps.groupCatalog(c, input)),
    },
    setProductTypes: {
      ...t.setProductTypes,
      execute: (input: Parameters<typeof steps.setProductTypes>[1]) =>
        run("agent", false, (c) => steps.setProductTypes(c, input)),
    },
    findPhotos: {
      ...t.findPhotos,
      execute: (input: { productIds?: string[] }) => run("research", false, (c) => steps.findPhotos(c, input)),
    },
  };
}
