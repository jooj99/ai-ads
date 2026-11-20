import "server-only";

import { buildAdBrief } from "@/lib/ads/brief";
import {
  AdStoppedError,
  chooseProducts,
  falCredentials,
  finishedByToolCall,
  renderAd,
  startAdRow,
} from "@/lib/ads/render";
import { logoImage, swatchImages } from "@/lib/ads/brand-assets";
import { adImageUrl } from "@/lib/ads/store";
import { getCampaignResearch } from "@/lib/campaigns";
import { resolveReferences, type AdReference } from "@/lib/uploads";

/**
 * Makes one new 9:16 ad with Nano Banana Pro edit on fal:
 * 1. picks the products (the agent's choice, else the first hero with a
 *    photo), keeping only photos that load;
 * 2. builds the brief from the brand kit (lib/ads/brief.ts);
 * 3. records the ad as "generating", renders it and stores the image
 *    (lib/ads/render.ts).
 *
 * Never throws: failures come back as `{ ok: false, summary }` for the chat,
 * and the row is marked "failed" with the reason. Called from the agent's
 * `generateAd` tool, i.e. inside a workflow step: a retried step finds its
 * finished ad by tool call id instead of paying for another image.
 */

export type GenerateAdInput = { headline: string; cta: string; productIds?: string[]; references?: AdReference[] };
export type AdToolResult = {
  ok: boolean;
  summary: string;
  ad?: { id: string; url: string; headline: string; cta: string };
  /** For edits: what visibly changed (see lib/ads/summarize.ts). */
  changes?: string[];
};

export async function generateAd(
  campaignId: string,
  input: GenerateAdInput,
  { toolCallId, runId }: { toolCallId?: string; runId?: string } = {},
): Promise<AdToolResult> {
  const label = `“${input.headline}”`;
  if (!falCredentials()) return { ok: false, summary: `Couldn't make the ad for ${label}: image generation isn't configured.` };

  const done = await finishedByToolCall(toolCallId);
  if (done) return adResult(campaignId, done.id, done.headline, done.cta, done.image_path, `Made the ad for ${label}.`);

  const research = await getCampaignResearch(campaignId).catch(() => null);
  const kit = research?.kit;
  if (!kit) return { ok: false, summary: `Couldn't make the ad for ${label}: research hasn't produced a brand kit yet.` };

  const products = await chooseProducts(kit, input.productIds ?? []);
  if (!products.length) {
    return { ok: false, summary: `Couldn't make the ad for ${label}: none of the chosen products has a photo that loads.` };
  }
  const refs = await resolveReferences(campaignId, input.references);
  if (refs.missing.length) {
    return { ok: false, summary: `Couldn't make the ad for ${label}: no attached image called ${refs.missing.map((m) => `"${m}"`).join(", ")}.` };
  }
  // The brand kit as images: the real logo (as a PNG) and a swatch per color.
  const [logo, swatches] = await Promise.all([logoImage(campaignId, kit.logo), swatchImages(campaignId, kit.colors)]);
  const brief = buildAdBrief({
    kit,
    headline: input.headline,
    cta: input.cta,
    products,
    logoUrl: logo?.url,
    swatches,
    references: refs.found,
  });
  // The row records our own images by storage path, never as signed URLs.
  const ours = [...refs.found, ...swatches, ...(logo ? [logo] : [])];
  const recorded = brief.imageUrls.map((u) => ours.find((r) => r.url === u)?.recorded ?? u);

  let adId: string;
  let number: number;
  try {
    ({ id: adId, number } = await startAdRow({
      campaign_id: campaignId,
      headline: input.headline,
      cta: input.cta,
      product_ids: products.map((p) => p.id),
      prompt: brief.prompt,
      system_prompt: brief.systemPrompt,
      image_inputs: recorded,
      tool_call_id: toolCallId ?? null,
      run_id: runId ?? null,
    }));
  } catch (error) {
    console.error("[ads] saving the ad row failed", error);
    return { ok: false, summary: `Couldn't make the ad for ${label}: saving it failed.` };
  }

  try {
    const { path } = await renderAd(campaignId, adId, brief);
    const names = products.map((p) => p.title).join(", ");
    const withRefs = refs.found.length ? ` and ${refs.found.length === 1 ? "your image" : `your ${refs.found.length} images`}` : "";
    return adResult(campaignId, adId, input.headline, input.cta, path, `Made Ad ${number} for ${label} with ${names}${withRefs}.`);
  } catch (error) {
    if (error instanceof AdStoppedError) return { ok: false, summary: `Stopped making the ad for ${label}.` };
    const reason = error instanceof Error ? error.message : "the image service failed";
    console.error("[ads] generation failed", reason);
    return { ok: false, summary: `Couldn't make the ad for ${label}: ${reason}` };
  }
}

export function adResult(
  campaignId: string,
  id: string,
  headline: string,
  cta: string,
  path: string,
  summary: string,
  changes?: string[],
): AdToolResult {
  return {
    ok: true,
    summary,
    ad: { id, url: adImageUrl(campaignId, path), headline, cta },
    ...(changes?.length && { changes }),
  };
}
