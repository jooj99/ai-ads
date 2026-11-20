import "server-only";

import { createFalClient } from "@fal-ai/client";
import { getRun } from "workflow/api";
import { WorkflowRunNotFoundError } from "workflow/internal/errors";

import { broadcastAdActivity } from "@/lib/ads/activity";
import { AD_MODEL, falCredentials } from "@/lib/ads/render";
import { AD_BUCKET } from "@/lib/ads/store";
import { supabase } from "@/lib/supabase/server";

/**
 * Ads that will never finish become "failed", so the studio stops showing
 * them as loading and offers Retry. An ad row is "generating" while its agent
 * run makes it; it can't finish when:
 *
 * - **its run died:** the run ended (failed, cancelled, or completed without
 *   finishing it) or no longer exists (a local dev database that was wiped);
 * - **it took too long:** still generating after `AD_TIMEOUT_MS`, even if its
 *   run is alive. Its fal job is cancelled, and whatever the run makes later
 *   is thrown away (`throwIfStopped` / `storeAdImage` only finish a row still
 *   generating, and report this reason instead).
 *
 * Runs on reads (the campaign page, the studio's re-reads while ads are
 * generating, the Campaigns list), not on a timer. Never throws.
 */

export const AD_TIMEOUT_MS = 10 * 60_000;

export const RUN_ENDED = "The run making it stopped before it finished.";
export const TIMED_OUT = "It took over 10 minutes, so it was stopped.";

type Row = { id: string; campaign_id: string; run_id: string | null; created_at: string; fal_request_id: string | null };

export async function expireStaleAds(campaignId?: string): Promise<number> {
  try {
    const db = supabase();
    let query = db
      .from("campaign_ads")
      .select("id, campaign_id, run_id, created_at, fal_request_id")
      .eq("status", "generating");
    if (campaignId) query = query.eq("campaign_id", campaignId);
    const { data, error } = await query;
    if (error) throw error;
    const rows = (data ?? []) as Row[];
    if (!rows.length) return 0;

    // One lookup per run.
    const runs = new Map<string, Promise<boolean>>();
    const ended = (runId: string) => {
      if (!runs.has(runId)) runs.set(runId, runEnded(runId));
      return runs.get(runId)!;
    };
    const now = Date.now();
    const dead: { row: Row; reason: string; runAlive: boolean }[] = [];
    for (const row of rows) {
      const runDead = row.run_id ? await ended(row.run_id) : false;
      if (runDead) dead.push({ row, reason: RUN_ENDED, runAlive: false });
      else if (now - Date.parse(row.created_at) >= AD_TIMEOUT_MS) {
        dead.push({ row, reason: TIMED_OUT, runAlive: Boolean(row.run_id) });
      }
    }
    if (!dead.length) return 0;

    const credentials = falCredentials();
    const fal = credentials ? createFalClient({ credentials }) : null;
    for (const { row, reason, runAlive } of dead) {
      const { data: updated } = await db
        .from("campaign_ads")
        .update({ status: "failed", error: reason })
        .eq("id", row.id)
        .eq("status", "generating") // it may have finished meanwhile
        .select("id");
      if (!updated?.length) continue;
      if (fal && row.fal_request_id) {
        await fal.queue.cancel(AD_MODEL, { requestId: row.fal_request_id }).catch(() => undefined);
      }
      // A live run still reads its drafts; it cleans them up when it sees the row failed.
      if (!runAlive) await removeWorkFiles(row.campaign_id, row.id);
      console.warn(`[ads] ad ${row.id} marked failed: ${reason}`);
    }
    for (const id of new Set(dead.map((d) => d.row.campaign_id))) await broadcastAdActivity(id);
    return dead.length;
  } catch (error) {
    console.error("[ads] expiring stale ads failed", error);
    return 0;
  }
}

/** Whether a run is over or gone. Unknown (a lookup error) counts as alive: the timeout still applies. */
async function runEnded(runId: string): Promise<boolean> {
  try {
    const status = await getRun(runId).status;
    return status === "completed" || status === "failed" || status === "cancelled";
  } catch (error) {
    return WorkflowRunNotFoundError.is(error);
  }
}

async function removeWorkFiles(campaignId: string, adId: string) {
  try {
    const bucket = supabase().storage.from(AD_BUCKET);
    const { data } = await bucket.list(campaignId, { search: `work-${adId}-`, limit: 100 });
    const names = (data ?? []).map((f) => `${campaignId}/${f.name}`);
    if (names.length) await bucket.remove(names);
  } catch {}
}
