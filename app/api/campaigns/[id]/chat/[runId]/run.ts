import "server-only";

import { getCampaign } from "@/lib/campaigns";

/**
 * Resolves the run a request means: a run id (`wrun_…`) as given, or the
 * campaign id itself for "the campaign's active run". Null when there's
 * none (or only a placeholder while a turn is starting).
 */
export async function activeRunFor(campaignId: string, runId: string): Promise<string | null> {
  if (runId !== campaignId) return runId;
  const campaign = await getCampaign(campaignId).catch(() => null);
  const active = campaign?.agentRunId;
  return active && !active.startsWith("starting-") ? active : null;
}
