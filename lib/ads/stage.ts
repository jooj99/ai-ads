import "server-only";

import { broadcast } from "@/lib/broadcast";
import { campaignTopic, EVENTS } from "@/lib/realtime";
import { supabase } from "@/lib/supabase/server";

/**
 * Live progress of ads being made, for the campaign page:
 *
 * - `setAdStage` records what an ad is doing now in `campaign_ads.stage`
 *   ("Drafting the image", "Fixing the logo (round 1 of 3)") and broadcasts
 *   it (`EVENTS.adStage`), so the chat and studio update without a re-read.
 * - `broadcastAdsChanged` tells the page an ad started, finished, failed or
 *   went away (`EVENTS.ads`), so it re-reads the ads at once: a finished ad
 *   shows the moment it's stored, not when the agent's whole reply ends.
 *
 * Both never throw: progress is nice to have, never worth failing an ad.
 */

export async function setAdStage(campaignId: string, adId: string, stage: string): Promise<void> {
  try {
    await supabase().from("campaign_ads").update({ stage }).eq("id", adId).eq("status", "generating");
    await broadcast(campaignTopic(campaignId), EVENTS.adStage, { id: adId, stage });
  } catch (error) {
    console.error("[ads] stage update failed", error);
  }
}

export async function broadcastAdsChanged(campaignId: string): Promise<void> {
  await broadcast(campaignTopic(campaignId), EVENTS.ads, {});
}
