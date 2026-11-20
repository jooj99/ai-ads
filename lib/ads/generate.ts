import "server-only";

import sharp from "sharp";

import { broadcastAdActivity } from "@/lib/ads/activity";
import { brandGraphics, logoImage, swatchImages } from "@/lib/ads/brand-assets";
import { buildAdBrief, ideaVisual, withoutEmoji } from "@/lib/ads/brief";
import { MAX_REPAIRS, runAdFlow, type AdCheck, type AdVerification } from "@/lib/ads/flow";
import {
  AdExpiredError,
  AdStoppedError,
  chooseProducts,
  failAdRow,
  falCredentials,
  falImage,
  finishedByToolCall,
  replaceFailedAd,
  startAdRow,
  storeAdImage,
  throwIfStopped,
  uploadWithRetry,
} from "@/lib/ads/render";
import { setAdStage } from "@/lib/ads/stage";
import { AD_BUCKET, adImageUrl } from "@/lib/ads/store";
import { describeIssues, fixAd, verifyAd, type AdIssue } from "@/lib/ads/verify";
import { getCampaignResearch } from "@/lib/campaigns";
import { supabase } from "@/lib/supabase/server";
import { resolveReferences, type AdReference } from "@/lib/uploads";
import type { IdeaDirection } from "@/lib/agent/tools";

/**
 * Makes one new 9:16 ad with Nano Banana Pro edit on fal, in phases (the
 * loop over them is lib/ads/flow.ts; the agent runs each phase as its own
 * durable workflow step):
 * 1. `startAd`: picks the products (the agent's choice, else the first hero
 *    with a photo, keeping only photos that load), builds the brief from the
 *    brand kit (lib/ads/brief.ts) with the real logo and a swatch per color
 *    as images (lib/ads/brand-assets.ts), records the ad as "generating" and
 *    renders a draft;
 * 2. `checkDraft`: a vision model checks the draft against the real products
 *    and logo (lib/ads/verify.ts);
 * 3. `repairDraft`: one boxed edit per problem, chained, up to three rounds
 *    while problems remain;
 * 4. `finishAd`: stores the best version. Problems still there are saved
 *    and shown beside the ad.
 *
 * Never throws: failures come back as `{ ok: false, summary }` for the chat,
 * and the row is marked "failed" with the reason. Drafts and repairs live in
 * our bucket as `<campaign>/work-<ad>-…png` until the finish.
 */

export type GenerateAdInput = {
  headline: string;
  cta: string;
  productIds?: string[];
  references?: AdReference[];
  /** The picked idea this ad makes (concept, scene, what it shows off). */
  idea?: IdeaDirection;
  /** A failed ad this one retries: it takes that ad's place and number, and its products and idea unless given. */
  retryOf?: string;
};
export type AdToolResult = {
  ok: boolean;
  summary: string;
  ad?: { id: string; url: string; headline: string; cta: string };
  /** For edits: what visibly changed (see lib/ads/summarize.ts). */
  changes?: string[];
};

/** What the later phases need about an ad being made (small: it's passed between workflow steps). */
export type AdJob = {
  campaignId: string;
  adId: string;
  number: number;
  headline: string;
  cta: string;
  /** "Black Bows, Cocoa Checkered" */
  productNames: string;
  references: number;
  productUrls: string[];
  services: boolean;
  /** Whether the idea shows the product (minimal ideas may not). */
  showProduct: boolean;
  /** The kit's logo URL, when it has one: the check compares the ad's logo with it. */
  logo?: string;
};

type Ctx = { toolCallId?: string; runId?: string };

/** The whole flow in one process (scripts, anything outside the agent's workflow). */
export function generateAd(campaignId: string, input: GenerateAdInput, ctx: Ctx = {}): Promise<AdToolResult> {
  return runAdFlow<AdJob, AdToolResult>({
    start: () => startAd(campaignId, input, ctx),
    check: checkDraft,
    repair: repairDraft,
    finish: finishAd,
  });
}

const label = (headline: string) => `“${headline}”`;
/** A draft (round 0) or a repair edit (round r, edit e) of an ad being made. */
const workPath = (job: AdJob, round: number, edit?: number) =>
  `${job.campaignId}/work-${job.adId}-${round}${edit ? `-${edit}` : ""}.png`;

export async function startAd(
  campaignId: string,
  copy: GenerateAdInput,
  { toolCallId, runId }: Ctx = {},
): Promise<{ result: AdToolResult } | { job: AdJob; draftPath: string }> {
  // A retry starts from what the failed ad was made with.
  const failed = copy.retryOf ? await failedAd(campaignId, copy.retryOf) : null;
  if (copy.retryOf && !failed) {
    return { result: { ok: false, summary: `Couldn't retry: there's no failed ad with the id ${copy.retryOf}.` } };
  }
  const base = {
    ...copy,
    productIds: copy.productIds?.length ? copy.productIds : failed?.productIds,
    idea: copy.idea ?? failed?.idea,
  };
  // Ads never show emojis: the ad (and its saved headline) uses the copy without them.
  const input = { ...base, headline: withoutEmoji(base.headline), cta: withoutEmoji(base.cta) };
  const fail = (why: string) => ({ result: { ok: false, summary: `Couldn't make the ad for ${label(input.headline)}: ${why}` } });
  if (!falCredentials()) return fail("image generation isn't configured.");

  const done = await finishedByToolCall(toolCallId);
  if (done) {
    return { result: adResult(campaignId, done.id, done.headline, done.cta, done.image_path, `Made the ad for ${label(input.headline)}.`) };
  }

  const research = await getCampaignResearch(campaignId).catch(() => null);
  const kit = research?.kit;
  if (!kit) return fail("research hasn't produced a brand kit yet.");

  // An id that isn't in the catalog must not quietly become the first hero:
  // the ad would show a product the user didn't ask for.
  const known = new Set([...(kit.catalog ?? []), ...kit.products].map((p) => p.id));
  const unknown = (input.productIds ?? []).filter((id) => !known.has(id));
  if (unknown.length) {
    return fail(
      `${unknown.map((id) => `"${id}"`).join(", ")} ${unknown.length === 1 ? "isn't" : "aren't"} in the catalog. Find the id with getCatalog, or add a linked product with addProductFromLink.`,
    );
  }
  // Only an ad that shows the product needs its photos; a brand-graphic or
  // type-only ad is just about it.
  const visual = ideaVisual(input.idea);
  const all = [...(kit.catalog ?? []), ...kit.products];
  const products =
    visual === "product"
      ? await chooseProducts(kit, input.productIds ?? [])
      : (input.productIds ?? []).flatMap((id) => all.filter((p) => p.id === id).slice(0, 1));
  if (!products.length) return fail("none of the chosen products has a photo that loads.");
  const refs = await resolveReferences(campaignId, input.references);
  if (refs.missing.length) return fail(`no attached image called ${refs.missing.map((m) => `"${m}"`).join(", ")}.`);

  // The brand kit as images: the real logo (as a PNG) and a swatch per color.
  // A brand-graphic idea uses the brand's own art from its site instead of product photos.
  const [logo, swatches, graphics] = await Promise.all([
    logoImage(campaignId, kit.logo),
    swatchImages(campaignId, kit.colors),
    visual === "brand_graphic" ? brandGraphics(kit) : Promise.resolve([]),
  ]);
  const brief = buildAdBrief({
    kit,
    headline: input.headline,
    cta: input.cta,
    products,
    logoUrl: logo?.url,
    swatches,
    references: refs.found,
    idea: input.idea,
    brandGraphics: graphics,
  });
  // The row records our own images by storage path, never as signed URLs.
  const ours = [...refs.found, ...swatches, ...(logo ? [logo] : [])];
  const recorded = brief.imageUrls.map((u) => ours.find((r) => r.url === u)?.recorded ?? u);

  let adId: string;
  let number: number;
  try {
    // Retrying an ad that failed: it's replaced, and this one takes its number.
    const retryOf = await replaceFailedAd(campaignId, input.headline, input.cta, copy.retryOf);
    ({ id: adId, number } = await startAdRow({
      ...(retryOf !== undefined && { number: retryOf }),
      campaign_id: campaignId,
      headline: input.headline,
      cta: input.cta,
      product_ids: products.map((p) => p.id),
      prompt: brief.prompt,
      system_prompt: brief.systemPrompt,
      image_inputs: recorded,
      tool_call_id: toolCallId ?? null,
      run_id: runId ?? null,
      idea: input.idea ?? null,
    }));
  } catch (error) {
    console.error("[ads] saving the ad row failed", error);
    return fail("saving it failed.");
  }

  const job: AdJob = {
    campaignId,
    adId,
    number,
    headline: input.headline,
    cta: input.cta,
    productNames: products.map((p) => p.title).join(", "),
    references: refs.found.length,
    // Every product photo the brief sent (up to 2 per product), so a design
    // shown only in a second photo isn't mistaken for a fake.
    productUrls: products.flatMap((p) => p.images.slice(0, 2)).slice(0, 6),
    services: kit.offering === "services",
    showProduct: visual === "product",
    ...(logo && { logo: kit.logo }),
  };
  try {
    await setAdStage(campaignId, adId, "Drafting the image");
    const draft = await falImage(brief, adId);
    const path = workPath(job, 0);
    const saved = await uploadWithRetry(path, draft.bytes);
    if (saved.error) throw new Error(`storing the image failed: ${saved.error.message}`);
    return { job, draftPath: path };
  } catch (error) {
    return { result: await failAd(job, error) };
  }
}

/** Checks a draft (or repair) in our bucket. Never throws. */
export async function checkDraft(job: AdJob, path: string): Promise<AdCheck> {
  const image = await readWork(path);
  if (!image) return { checked: false, issues: [] };
  const first = path.endsWith(`work-${job.adId}-0.png`);
  await setAdStage(
    job.campaignId,
    job.adId,
    first
      ? `Checking the ${job.showProduct === false ? "logo and text" : "logo, products and text"} against the real ones`
      : "Checking the fixes",
  );
  const logo = job.logo ? await logoImage(job.campaignId, job.logo) : null;
  return verifyAd({
    image,
    logoUrl: logo?.url,
    productUrls: job.productUrls,
    services: job.services,
    productShown: job.showProduct !== false,
    headline: job.headline,
    cta: job.cta,
  });
}

/** One edit for one problem: the edited copy's path, `{}` if it failed, or a result if stopped. */
export async function repairDraft(
  job: AdJob,
  path: string,
  issue: AdIssue,
  round: number,
  edit: number,
): Promise<{ path?: string; result?: AdToolResult }> {
  try {
    await throwIfStopped(job.adId); // don't pay for a repair the user stopped
    const image = await readWork(path);
    if (!image) return {};
    console.warn(`[ads] Ad ${job.number}: repair ${round}.${edit} for ${issue.kind} at ${issue.where}`);
    await setAdStage(job.campaignId, job.adId, `Fixing ${repairTarget(issue)} (round ${round} of ${MAX_REPAIRS})`);
    const logo = issue.kind === "logo" && job.logo ? await logoImage(job.campaignId, job.logo) : null;
    const repaired = await fixAd({
      campaignId: job.campaignId,
      adId: job.adId,
      draft: { bytes: image, width: null, height: null, requestId: "" },
      issue,
      productUrls: job.productUrls,
      logoUrl: logo?.url,
      headline: job.headline,
      cta: job.cta,
    });
    const out = workPath(job, round, edit);
    const saved = await uploadWithRetry(out, repaired.bytes);
    return saved.error ? {} : { path: out };
  } catch (error) {
    if (error instanceof AdStoppedError) return { result: stopped(job) };
    if (error instanceof AdExpiredError) return { result: await failAd(job, error) };
    console.error(`[ads] repair ${round}.${edit} failed`, error);
    return {};
  }
}

/** Stores the chosen version and reports it. Never throws. */
export async function finishAd(job: AdJob, path: string, verification: AdVerification): Promise<AdToolResult> {
  try {
    await setAdStage(job.campaignId, job.adId, "Saving the ad");
    const bytes = await readWork(path);
    if (!bytes) throw new Error("the draft went missing");
    const { width, height } = await sharp(bytes).metadata();
    const { path: stored } = await storeAdImage(
      job.campaignId,
      job.adId,
      { bytes, width: width ?? null, height: height ?? null, requestId: "" },
      { verification },
    );
    await removeWork(job);

    const withRefs = job.references ? ` and ${job.references === 1 ? "your image" : `your ${job.references} images`}` : "";
    const { first, remaining, rounds } = verification;
    const check = !verification.checked
      ? ""
      : !first.length
        ? " Checked: the logo and products match the real ones."
        : !remaining.length
          ? ` The first image had ${describeIssues(first)}, so it was fixed before showing.`
          : ` Still not right after ${rounds} ${rounds === 1 ? "fix" : "fixes"}: ${remaining.map((i) => i.problem.replace(/\.$/, "")).join("; ")}.`;
    return adResult(
      job.campaignId,
      job.adId,
      job.headline,
      job.cta,
      stored,
      `Made Ad ${job.number} for ${label(job.headline)} with ${job.productNames}${withRefs}.${check}`,
    );
  } catch (error) {
    return failAd(job, error);
  } finally {
    // Done either way (ready, failed or stopped): update the Campaigns list.
    await broadcastAdActivity(job.campaignId);
  }
}

/** Marks the ad failed (or reports it stopped) and cleans up its work files. */
async function failAd(job: AdJob, error: unknown): Promise<AdToolResult> {
  await removeWork(job);
  if (error instanceof AdStoppedError) return stopped(job);
  const reason = error instanceof Error ? error.message : "the image service failed";
  console.error("[ads] generation failed", reason);
  await failAdRow(job.adId, reason);
  await broadcastAdActivity(job.campaignId);
  return { ok: false, summary: `Couldn't make the ad for ${label(job.headline)}: ${reason}` };
}

function stopped(job: AdJob): AdToolResult {
  return { ok: false, summary: `Stopped making the ad for ${label(job.headline)}.` };
}

async function readWork(path: string): Promise<Uint8Array | null> {
  const { data, error } = await supabase().storage.from(AD_BUCKET).download(path);
  if (error || !data) {
    console.error(`[ads] reading ${path} failed`, error);
    return null;
  }
  return new Uint8Array(await data.arrayBuffer());
}

/** What a repair fixes, for its stage: "the logo", "the product (the case in her hand)". */
function repairTarget(issue: AdIssue): string {
  const short = (s: string) => (s.length > 60 ? `${s.slice(0, 57).trimEnd()}…` : s);
  switch (issue.kind) {
    case "logo":
      return "the logo";
    case "logo_box":
      return "the box around the logo";
    case "fake_product":
      return issue.where ? `the product (${short(issue.where)})` : "the product";
    case "fake_screen":
      return "an invented screen";
    case "artifact":
      return "leftover marks";
    case "copy":
      return "the text";
    default:
      return "a problem";
  }
}

/** The products and idea a failed new ad (not an edit) of this campaign was made with. */
async function failedAd(
  campaignId: string,
  adId: string,
): Promise<{ productIds: string[]; idea?: IdeaDirection } | null> {
  const { data } = await supabase()
    .from("campaign_ads")
    .select("product_ids, idea")
    .eq("campaign_id", campaignId)
    .eq("id", adId)
    .eq("status", "failed")
    .is("parent_id", null)
    .maybeSingle();
  if (!data) return null;
  return { productIds: (data.product_ids as string[] | null) ?? [], idea: (data.idea as IdeaDirection | null) ?? undefined };
}

/** Deletes the ad's drafts and repair edits (`work-<ad>-…`). */
async function removeWork(job: AdJob) {
  const bucket = supabase().storage.from(AD_BUCKET);
  const { data } = await bucket.list(job.campaignId, { search: `work-${job.adId}-`, limit: 100 });
  const paths = (data ?? []).map((f) => `${job.campaignId}/${f.name}`);
  if (paths.length) await bucket.remove(paths).catch(() => undefined);
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
