import "server-only";

import { getCampaign, runBelongsTo } from "@/lib/campaigns";

/** Workflow run ids look like `wrun_01K…`. */
const RUN_ID = /^wrun_[0-9A-Za-z]{10,40}$/;

/**
 * Resolves the run a request means: the campaign id itself for "the
 * campaign's active run", or a run id, which must be one of this campaign's
 * runs (`campaign_runs`, or its active run), so a run id from another
 * campaign can't be stopped or read through this one's URL. Null when
 * there's none (or only a placeholder while a turn is starting).
 */
export async function activeRunFor(campaignId: string, runId: string): Promise<string | null> {
  const campaign = await getCampaign(campaignId).catch(() => null);
  if (!campaign) return null;
  const active = campaign.agentRunId && !campaign.agentRunId.startsWith("starting-") ? campaign.agentRunId : null;
  if (runId === campaignId) return active;
  if (!RUN_ID.test(runId)) return null;
  if (runId === active) return runId;
  return (await runBelongsTo(campaignId, runId).catch(() => false)) ? runId : null;
}
