import { start } from "workflow/api";

import { claimResearch, getCampaign } from "@/lib/campaigns";
import { openResearchThread } from "@/lib/agent/research-thread";
import { researchRun } from "@/workflows/agent";

/**
 * Starts (or restarts) research for a campaign as a durable agent run
 * (workflows/agent.ts) and returns at once; the page reconnects to the run's
 * stream. 202 { started, runId } when a run began; 409 when one is already
 * running.
 */
export async function POST(_req: Request, ctx: RouteContext<"/api/campaigns/[id]/research">) {
  const { id } = await ctx.params;
  const campaign = await getCampaign(id).catch(() => null);
  if (!campaign) return Response.json({ error: "Campaign not found" }, { status: 404 });

  const claimed = await claimResearch(id);
  if (!claimed) return Response.json({ started: false, reason: "already running" }, { status: 409 });

  const run = await start(researchRun, [id]);
  const thread = await openResearchThread(id, run.runId); // so the page can follow the run at once
  return Response.json({ started: true, runId: run.runId, opening: thread.at(-1) }, { status: 202 });
}
