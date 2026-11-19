import { after } from "next/server";

import { claimResearch, getCampaign } from "@/lib/campaigns";
import { runClaimedResearch } from "@/lib/research/run";

// Research runs after the response (via after/waitUntil); give it room.
export const maxDuration = 300;

/**
 * Starts (or restarts) research for a campaign in the background and returns
 * at once. Progress reaches pages over Supabase Realtime, not this response.
 * 202 { started: true } when a run began; 409 when one is already running.
 */
export async function POST(_req: Request, ctx: RouteContext<"/api/campaigns/[id]/research">) {
  const { id } = await ctx.params;
  const campaign = await getCampaign(id).catch(() => null);
  if (!campaign) return Response.json({ error: "Campaign not found" }, { status: 404 });

  const claimed = await claimResearch(id);
  if (!claimed) return Response.json({ started: false, reason: "already running" }, { status: 409 });

  after(() => runClaimedResearch(id));
  return Response.json({ started: true }, { status: 202 });
}
