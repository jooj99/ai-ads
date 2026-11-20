import "server-only";

import sharp from "sharp";

import { broadcastAdActivity } from "@/lib/ads/activity";
import { logoImage, swatchImages } from "@/lib/ads/brand-assets";
import { buildAdBrief } from "@/lib/ads/brief";
import { runAdFlow, type AdCheck, type AdVerification } from "@/lib/ads/flow";
import {
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
import { AD_BUCKET, adImageUrl } from "@/lib/ads/store";
import { describeIssues, fixAd, verifyAd, type AdIssue } from "@/lib/ads/verify";
import { getCampaignResearch } from "@/lib/campaigns";
import { supabase } from "@/lib/supabase/server";
import { resolveReferences, type AdReference } from "@/lib/uploads";

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

export type GenerateAdInput = { headline: string; cta: string; productIds?: string[]; references?: AdReference[] };
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
  input: GenerateAdInput,
  { toolCallId, runId }: Ctx = {},
): Promise<{ result: AdToolResult } | { job: AdJob; draftPath: string }> {
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
  const products = await chooseProducts(kit, input.productIds ?? []);
  if (!products.length) return fail("none of the chosen products has a photo that loads.");
  const refs = await resolveReferences(campaignId, input.references);
  if (refs.missing.length) return fail(`no attached image called ${refs.missing.map((m) => `"${m}"`).join(", ")}.`);

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
    // Retrying an ad that failed: it's replaced, and this one takes its number.
    const retryOf = await replaceFailedAd(campaignId, input.headline, input.cta);
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
    ...(logo && { logo: kit.logo }),
  };
  try {
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
  const logo = job.logo ? await logoImage(job.campaignId, job.logo) : null;
  return verifyAd({ image, logoUrl: logo?.url, productUrls: job.productUrls, services: job.services });
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
    console.error(`[ads] repair ${round}.${edit} failed`, error);
    return {};
  }
}

/** Stores the chosen version and reports it. Never throws. */
export async function finishAd(job: AdJob, path: string, verification: AdVerification): Promise<AdToolResult> {
  try {
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
