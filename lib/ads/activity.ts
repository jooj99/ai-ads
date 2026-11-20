import "server-only";

import { CAMPAIGNS_TOPIC, EVENTS, type AdActivity } from "@/lib/realtime";
import { supabase } from "@/lib/supabase/server";

/**
 * Per campaign, for the Campaigns list: ads in progress ("Making 2 ads…")
 * and how many finished ads it has ("3 ads": ads with a ready version, each
 * counted once however many versions it has). A row still "generating" after
 * 5 minutes died with its run and isn't counted (the studio treats it the
 * same way).
 */
const STUCK_MS = 5 * 60_000;

export async function adActivity(campaignIds?: string[]): Promise<Map<string, AdActivity>> {
  let query = supabase()
    .from("campaign_ads")
    .select("campaign_id, parent_id, number, status, created_at")
    .in("status", ["generating", "ready"]);
  if (campaignIds) query = query.in("campaign_id", campaignIds);
  const { data, error } = await query;
  if (error) throw error;
  const since = Date.now() - STUCK_MS;
  const activity = new Map<string, AdActivity>();
  const numbers = new Map<string, Set<number>>();
  for (const row of data ?? []) {
    const a = activity.get(row.campaign_id) ?? { making: 0, editing: 0, total: 0 };
    activity.set(row.campaign_id, a);
    if (row.status === "ready") {
      const seen = numbers.get(row.campaign_id) ?? new Set<number>();
      seen.add(row.number);
      numbers.set(row.campaign_id, seen);
      a.total = seen.size;
    } else if (Date.parse(row.created_at) > since) {
      if (row.parent_id) a.editing++;
      else a.making++;
    }
  }
  return activity;
}

/** Tells the Campaigns list a campaign's ads in progress changed (an ad started, finished, failed or stopped). Never throws. */
export async function broadcastAdActivity(campaignId: string): Promise<void> {
  try {
    const ads = (await adActivity([campaignId])).get(campaignId) ?? { making: 0, editing: 0, total: 0 };
    await supabase()
      .channel(CAMPAIGNS_TOPIC)
      .httpSend(EVENTS.changed, { id: campaignId, ads, at: new Date().toISOString() });
  } catch (error) {
    console.error("[ads] activity broadcast failed", error);
  }
}
