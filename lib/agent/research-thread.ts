import "server-only";

import { kickoffText, type AgentUIMessage } from "@/lib/agent/tools";
import { getCampaign, getChat, saveChat } from "@/lib/campaigns";
import { supabase } from "@/lib/supabase/server";

/** The opening message of a research run; its id is tied to the run, so adding it twice is a no-op. */
export function openingMessage(runId: string, domain: string, again: boolean): AgentUIMessage {
  return {
    id: `msg-${runId}`,
    role: "user",
    parts: [{ type: "text", text: again ? `Research ${domain} again` : kickoffText(domain) }],
  };
}

/**
 * Marks a research run as the campaign's active run and adds its opening
 * message to the thread. Called right after starting the run (so the page
 * that loads next can reconnect to it at once) and again by the run's first
 * step; both are idempotent. Returns the thread.
 */
export async function openResearchThread(campaignId: string, runId: string): Promise<AgentUIMessage[]> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) throw new Error("Campaign not found");
  await supabase().from("campaigns").update({ agent_run_id: runId }).eq("id", campaignId);
  const thread = await getChat(campaignId);
  const opening = openingMessage(runId, campaign.domain, thread.some((m) => m.id !== `msg-${runId}`));
  if (thread.some((m) => m.id === opening.id)) return thread;
  const next = [...thread, opening];
  await saveChat(campaignId, next);
  return next;
}
