import "server-only";

import { createFalClient } from "@fal-ai/client";

import { broadcastAdActivity } from "@/lib/ads/activity";
import { AD_BUCKET } from "@/lib/ads/store";
import type { BrandKit, CatalogItem } from "@/lib/research/types";
import { isPublicHttpUrl } from "@/lib/research/url";
import { supabase } from "@/lib/supabase/server";

/**
 * What new ads (generate.ts) and edits (edit.ts) share: the fal call, copying
 * its image into our storage, and choosing product photos that will load.
 */

export const AD_MODEL = "fal-ai/nano-banana-pro/edit";
const RESOLUTION = "2K";
// Generous for one image, but leaves room for a check and a fix inside one 300s step.
const FAL_TIMEOUT_MS = 150_000;
const MAX_PRODUCTS = 3;

export function falCredentials() {
  return process.env.FALAI_KEY ?? process.env.FAL_KEY;
}

/** One ad row's fields while it's being made. */
export type AdRowInput = {
  campaign_id: string;
  headline: string;
  cta: string;
  product_ids: string[];
  prompt: string;
  system_prompt: string;
  image_inputs: string[];
  parent_id?: string | null;
  instruction?: string | null;
  tool_call_id: string | null;
  /** The agent run making it; stopping that run cancels it (see cancelRunAds). */
  run_id?: string | null;
  /** The picked idea it makes, if any (shown in the studio). */
  idea?: unknown;
  /** Set when it retries a failed ad, to take that ad's number; else the next one. */
  number?: number;
};

/** Thrown when the run making an ad was stopped: its result is thrown away. */
export class AdStoppedError extends Error {
  constructor() {
    super("stopped");
  }
}

/**
 * Thrown when an ad was given up on while its run was still making it (see
 * `expireStaleAds`): the row is already "failed" with this reason, and the
 * run's result is thrown away. The tool reports it as a failure.
 */
export class AdExpiredError extends Error {}

/**
 * Records an ad as "generating" (or reuses the row a retried tool call made).
 * Returns its id and number (the database numbers new ads; edits share their
 * ad's number).
 */
export async function startAdRow(row: AdRowInput): Promise<{ id: string; number: number }> {
  const db = supabase();
  const full = { ...row, model: AD_MODEL, status: "generating", error: null };
  const saved = row.tool_call_id
    ? await db.from("campaign_ads").upsert(full, { onConflict: "tool_call_id" }).select("id, number").single()
    : await db.from("campaign_ads").insert(full).select("id, number").single();
  if (saved.error) throw saved.error;
  // A stop that came while this ad was being prepared found no row to cancel.
  if (row.run_id && (await runStopped(row.campaign_id, row.run_id))) {
    await db.from("campaign_ads").delete().eq("id", saved.data.id);
    throw new AdStoppedError();
  }
  await broadcastAdActivity(row.campaign_id); // the Campaigns list shows "Making an ad…"
  return { id: saved.data.id as string, number: (saved.data.number as number) ?? 0 };
}

/**
 * Whether the user stopped this agent run (the stop route records it as the
 * campaign's `stopped_run_id`). Ads check it before they start, since a stop
 * that comes before an ad's row exists has nothing to cancel. Never throws.
 */
export async function runStopped(campaignId: string, runId: string): Promise<boolean> {
  try {
    const { data } = await supabase().from("campaigns").select("stopped_run_id").eq("id", campaignId).maybeSingle();
    return data?.stopped_run_id === runId;
  } catch {
    return false;
  }
}

/**
 * A retry of an ad that failed (never made): the failed ad named by
 * `retryOf`, else any with the same headline and CTA. Deletes it and returns
 * its number, so the retry takes its place ("Ad 2" again) instead of leaving
 * a broken ad in the list. Undefined when there's nothing to replace. Never
 * throws.
 */
export async function replaceFailedAd(
  campaignId: string,
  headline: string,
  cta: string,
  retryOf?: string,
): Promise<number | undefined> {
  try {
    const db = supabase();
    let query = db
      .from("campaign_ads")
      .select("id, number")
      .eq("campaign_id", campaignId)
      .eq("status", "failed")
      .is("parent_id", null);
    query = retryOf ? query.eq("id", retryOf) : query.eq("headline", headline).eq("cta", cta);
    const { data } = await query.order("created_at", { ascending: false });
    if (!data?.length) return undefined;
    // Only ads with no other versions (a failed ad never got any).
    const ids = data.map((r) => r.id as string);
    const { data: children } = await db.from("campaign_ads").select("parent_id").in("parent_id", ids);
    const parents = new Set((children ?? []).map((c) => c.parent_id as string));
    const failed = data.filter((r) => !parents.has(r.id as string));
    if (!failed.length) return undefined;
    await db.from("campaign_ads").delete().in("id", failed.map((r) => r.id as string));
    return failed[0].number as number;
  } catch (error) {
    console.error("[ads] replacing the failed ad failed", error);
    return undefined;
  }
}

/** A finished ad an earlier attempt of the same tool call already made, if any. */
export async function finishedByToolCall(toolCallId?: string) {
  if (!toolCallId) return null;
  const { data } = await supabase()
    .from("campaign_ads")
    .select("id, headline, cta, image_path")
    .eq("tool_call_id", toolCallId)
    .eq("status", "ready")
    .maybeSingle();
  return data?.image_path ? (data as { id: string; headline: string; cta: string; image_path: string }) : null;
}

/** A finished image from fal, downloaded (fal's URL expires, so we keep the bytes). */
export type FalImage = { bytes: Uint8Array; width: number | null; height: number | null; requestId: string };

/**
 * Calls Nano Banana Pro edit for one 9:16 image and downloads it. Throws
 * with a short reason.
 *
 * The standing rules (`systemPrompt`) go at the top of the prompt itself:
 * fal's documented input for this endpoint is prompt, image_urls,
 * aspect_ratio, resolution, output_format, num_images and a few flags, with
 * no system field, so a separate one could be dropped silently.
 */
export async function falImage(
  input: { prompt: string; systemPrompt: string; imageUrls: string[] },
  /** The ad row, to record fal's request id as soon as it's queued (so a stop can cancel it). */
  adId?: string,
): Promise<FalImage> {
  const credentials = falCredentials();
  if (!credentials) throw new Error("image generation isn't configured");
  try {
    const fal = createFalClient({ credentials });
    const result = await fal.subscribe(AD_MODEL, {
      input: {
        prompt: `${input.systemPrompt}\n\n---\n\n${input.prompt}`,
        image_urls: input.imageUrls,
        aspect_ratio: "9:16",
        resolution: RESOLUTION,
        output_format: "png",
        num_images: 1,
        // Exactly one image, whatever the prompt says about counts.
        limit_generations: true,
      },
      timeout: FAL_TIMEOUT_MS,
      onEnqueue: (requestId) => {
        if (adId) void supabase().from("campaign_ads").update({ fal_request_id: requestId }).eq("id", adId).then();
      },
    });
    const image = result.data.images?.[0];
    if (!image?.url) throw new Error("the model returned no image");
    const res = await fetch(image.url);
    if (!res.ok) throw new Error(`downloading the image failed (${res.status})`);
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      width: image.width ?? null,
      height: image.height ?? null,
      requestId: result.requestId,
    };
  } catch (error) {
    throw new Error(falMessage(error));
  }
}

/** Copies an image into the `ads` bucket and marks its row ready (with any extra columns). */
export async function storeAdImage(
  campaignId: string,
  adId: string,
  image: FalImage,
  extra: Record<string, unknown> = {},
): Promise<{ path: string }> {
  const db = supabase();
  await throwIfStopped(adId);
  const path = `${campaignId}/${adId}.png`;
  const upload = await uploadWithRetry(path, image.bytes);
  if (upload.error) throw new Error(`storing the image failed: ${upload.error.message}`);
  // Only a row still being made becomes ready; a stopped one is gone by now.
  const { data: updated } = await db
    .from("campaign_ads")
    .update({
      status: "ready",
      image_path: path,
      width: image.width,
      height: image.height,
      ...(image.requestId && { fal_request_id: image.requestId }),
      ...extra,
    })
    .eq("id", adId)
    .eq("status", "generating")
    .select("id");
  if (!updated?.length) {
    await db.storage.from(AD_BUCKET).remove([path]);
    const { data: row } = await db.from("campaign_ads").select("status, error").eq("id", adId).maybeSingle();
    if (row?.status === "failed") throw new AdExpiredError(row.error ?? "it was stopped");
    throw new AdStoppedError();
  }
  // Shown at once, before the tool call wraps up (an edit still writes its summary).
  await broadcastAdActivity(campaignId);
  return { path };
}

/**
 * Uploads an ad image to our bucket. The image is paid for by now, so a
 * storage hiccup (Supabase's 520s) gets two more tries before it counts as
 * a failure.
 */
export async function uploadWithRetry(path: string, bytes: Uint8Array) {
  const bucket = supabase().storage.from(AD_BUCKET);
  let upload = await bucket.upload(path, bytes, { contentType: "image/png", upsert: true });
  for (const wait of [1_500, 5_000]) {
    if (!upload.error) break;
    console.warn(`[ads] storing the image failed (${upload.error.message}); trying again`);
    await new Promise((r) => setTimeout(r, wait));
    upload = await bucket.upload(path, bytes, { contentType: "image/png", upsert: true });
  }
  return upload;
}

/**
 * Whether the run making this ad was stopped: its row was removed by the
 * stop route, or its run is no longer the campaign's active run (stopped
 * and replaced, or ended). A normal run is still active while its tools run.
 * An ad given up on meanwhile (`expireStaleAds`) throws `AdExpiredError`
 * with its reason instead.
 */
export async function throwIfStopped(adId: string): Promise<void> {
  const db = supabase();
  const { data: row } = await db
    .from("campaign_ads")
    .select("campaign_id, run_id, status, error")
    .eq("id", adId)
    .maybeSingle();
  if (row?.status === "failed") throw new AdExpiredError(row.error ?? "it was stopped");
  if (!row || row.status !== "generating") throw new AdStoppedError();
  if (!row.run_id) return;
  const { data: campaign } = await db
    .from("campaigns")
    .select("agent_run_id, stopped_run_id")
    .eq("id", row.campaign_id)
    .maybeSingle();
  if (campaign?.agent_run_id !== row.run_id || campaign?.stopped_run_id === row.run_id) {
    await db.from("campaign_ads").delete().eq("id", adId);
    throw new AdStoppedError();
  }
}

/**
 * Cancels the ads a stopped run was making: cancels their fal jobs (so they
 * stop costing) and removes their rows, so nothing is left loading. Called by
 * the stop route; whatever those jobs return later is thrown away.
 */
export async function cancelRunAds(campaignId: string, runId: string): Promise<number> {
  const db = supabase();
  const { data: rows } = await db
    .from("campaign_ads")
    .select("id, fal_request_id")
    .eq("campaign_id", campaignId)
    .eq("run_id", runId)
    .eq("status", "generating");
  if (!rows?.length) return 0;
  const credentials = falCredentials();
  if (credentials) {
    const fal = createFalClient({ credentials });
    await Promise.all(
      rows
        .filter((r) => r.fal_request_id)
        .map((r) => fal.queue.cancel(AD_MODEL, { requestId: r.fal_request_id! }).catch(() => undefined)),
    );
  }
  await db.from("campaign_ads").delete().in("id", rows.map((r) => r.id));
  await broadcastAdActivity(campaignId);
  return rows.length;
}

/** Marks an ad row failed with the reason. */
export async function failAdRow(adId: string, reason: string) {
  await supabase().from("campaign_ads").update({ status: "failed", error: reason }).eq("id", adId);
}

/**
 * One new ad: renders it, stores the image and marks the row ready. Throws
 * on failure, after marking the row failed with the reason.
 */
export async function renderAd(
  campaignId: string,
  adId: string,
  input: { prompt: string; systemPrompt: string; imageUrls: string[] },
): Promise<{ path: string }> {
  try {
    return await storeAdImage(campaignId, adId, await falImage(input, adId));
  } catch (error) {
    if (error instanceof AdStoppedError) throw error;
    const reason = error instanceof Error ? error.message : "the image service failed";
    await failAdRow(adId, reason);
    throw new Error(reason);
  }
}

/**
 * The products to feature: the given ids (up to 3) that have photos, else
 * (when `fallbackToHero`) the first hero with one. Each keeps only photos
 * that load, so fal never fails on a dead image URL.
 */
export async function chooseProducts(kit: BrandKit, ids: string[], fallbackToHero = true): Promise<CatalogItem[]> {
  const all = new Map<string, CatalogItem>();
  for (const p of [...(kit.catalog ?? []), ...kit.products]) if (!all.has(p.id)) all.set(p.id, p);
  const asked = ids.map((id) => all.get(id)).filter((p): p is CatalogItem => Boolean(p));
  const candidates = asked.length ? asked : fallbackToHero ? kit.products : [];

  const chosen: CatalogItem[] = [];
  for (const product of candidates) {
    if (chosen.length >= (asked.length ? MAX_PRODUCTS : 1)) break;
    const photos = (await Promise.all(product.images.slice(0, 3).map(async (url) => ((await loads(url)) ? url : null))))
      .filter((u): u is string => Boolean(u));
    if (photos.length) chosen.push({ ...product, images: photos });
  }
  return chosen;
}

/** Whether a URL is a public image that fal will be able to fetch. */
export async function loads(url: string): Promise<boolean> {
  if (!isPublicHttpUrl(url)) return false;
  try {
    const res = await fetch(url, { method: "GET", headers: { range: "bytes=0-0" }, signal: AbortSignal.timeout(6_000) });
    void res.body?.cancel();
    return res.ok && (res.headers.get("content-type") ?? "").startsWith("image/");
  } catch {
    return false;
  }
}

/** A short reason from a fal error (its API errors carry a `body.detail`). */
export function falMessage(error: unknown): string {
  const detail = (error as { body?: { detail?: unknown } })?.body?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail[0] && typeof detail[0] === "object" && "msg" in detail[0]) {
    return String((detail[0] as { msg: unknown }).msg);
  }
  return error instanceof Error ? error.message : "the image service failed";
}
