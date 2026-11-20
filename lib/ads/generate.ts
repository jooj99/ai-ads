import "server-only";

import { buildAdBrief } from "@/lib/ads/brief";
import {
  AdStoppedError,
  chooseProducts,
  failAdRow,
  falCredentials,
  falImage,
  finishedByToolCall,
  startAdRow,
  storeAdImage,
  throwIfStopped,
} from "@/lib/ads/render";
import { describeIssues, fixAd, verifyAd } from "@/lib/ads/verify";
import { broadcastAdActivity } from "@/lib/ads/activity";
import { logoImage, swatchImages } from "@/lib/ads/brand-assets";
import { adImageUrl } from "@/lib/ads/store";
import { getCampaignResearch } from "@/lib/campaigns";
import { resolveReferences, type AdReference } from "@/lib/uploads";

/**
 * Makes one new 9:16 ad with Nano Banana Pro edit on fal:
 * 1. picks the products (the agent's choice, else the first hero with a
 *    photo), keeping only photos that load;
 * 2. builds the brief from the brand kit (lib/ads/brief.ts);
 * 3. records the ad as "generating" and renders a draft;
 * 4. checks the draft against the real logo and products (lib/ads/verify.ts)
 *    and, if the logo is wrong or a product or screen is invented, fixes it
 *    and checks again, all before the ad is stored and shown.
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

  // An id that isn't in the catalog must not quietly become the first hero:
  // the ad would show a product the user didn't ask for.
  const known = new Set([...(kit.catalog ?? []), ...kit.products].map((p) => p.id));
  const unknown = (input.productIds ?? []).filter((id) => !known.has(id));
  if (unknown.length) {
    return {
      ok: false,
      summary: `Couldn't make the ad for ${label}: ${unknown.map((id) => `"${id}"`).join(", ")} ${unknown.length === 1 ? "isn't" : "aren't"} in the catalog. Find the id with getCatalog, or add a linked product with addProductFromLink.`,
    };
  }
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
    // Draft, then check it against the real logo and products before anyone
    // sees it (the row stays "generating" until it's stored). Problems get
    // one fix pass and a re-check; the closer result is kept.
    // Every product photo the brief sent (up to 2 per product), so a design shown
    // only in a second photo isn't mistaken for a fake.
    const productUrls = products.flatMap((p) => p.images.slice(0, 2)).slice(0, 6);
    const services = kit.offering === "services";
    const draft = await falImage(brief, adId);
    const first = await verifyAd({ image: draft.bytes, logoUrl: logo?.url, productUrls, services });
    let final = draft;
    let remaining = first.issues;
    let fixed = false;
    if (first.issues.length) {
      console.warn(`[ads] Ad ${number}: check found ${first.issues.map((i) => i.kind).join(", ")}; fixing`);
      await throwIfStopped(adId);
      const repaired = await fixAd({
        campaignId,
        adId,
        draft,
        issues: first.issues,
        logoUrl: logo?.url,
        productUrls,
        headline: input.headline,
        cta: input.cta,
      }).catch((error) => {
        console.error("[ads] fixing the ad failed", error);
        return null;
      });
      if (repaired) {
        const again = await verifyAd({ image: repaired.bytes, logoUrl: logo?.url, productUrls, services });
        if (again.issues.length < first.issues.length) {
          final = repaired;
          remaining = again.issues;
          fixed = true;
        }
      }
    }
    const { path } = await storeAdImage(campaignId, adId, final, {
      verification: { checked: first.checked, first: first.issues, fixed, remaining },
    });

    const names = products.map((p) => p.title).join(", ");
    const withRefs = refs.found.length ? ` and ${refs.found.length === 1 ? "your image" : `your ${refs.found.length} images`}` : "";
    const check = !first.checked
      ? ""
      : fixed
        ? ` The first image had ${describeIssues(first.issues)}, so it was fixed before showing.`
        : first.issues.length
          ? ""
          : " Checked: the logo and products match the real ones.";
    const still = remaining.length ? ` Still not right: ${remaining.map((i) => i.problem.replace(/\.$/, "")).join("; ")}.` : "";
    return adResult(
      campaignId,
      adId,
      input.headline,
      input.cta,
      path,
      `Made Ad ${number} for ${label} with ${names}${withRefs}.${check}${still}`,
    );
  } catch (error) {
    if (error instanceof AdStoppedError) return { ok: false, summary: `Stopped making the ad for ${label}.` };
    const reason = error instanceof Error ? error.message : "the image service failed";
    console.error("[ads] generation failed", reason);
    await failAdRow(adId, reason);
    return { ok: false, summary: `Couldn't make the ad for ${label}: ${reason}` };
  } finally {
    // Done either way (ready, failed or stopped): update the Campaigns list.
    await broadcastAdActivity(campaignId);
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
