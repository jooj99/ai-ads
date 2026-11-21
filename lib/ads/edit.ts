import "server-only";

import { randomUUID } from "node:crypto";

import { adResult, type AdToolResult } from "@/lib/ads/generate";
import { describeRegion, drawLocationMap, type Region } from "@/lib/ads/markers";
import { WEBP, workWebp } from "@/lib/ads/webp";
import {
  AdStoppedError,
  chooseProducts,
  failAdRow,
  falCredentials,
  falImage,
  finishedByToolCall,
  startAdRow,
  storeAdImage,
  runStopped,
  throwIfStopped,
  type FalImage,
} from "@/lib/ads/render";
import { broadcastAdActivity } from "@/lib/ads/activity";
import { checkEdit, type EditCheck } from "@/lib/ads/retention";
import { findArtifacts, fixAd } from "@/lib/ads/verify";
import { summarizeEdit } from "@/lib/ads/summarize";
import { setAdStage } from "@/lib/ads/stage";
import { AD_BUCKET } from "@/lib/ads/store";
import { supabase } from "@/lib/supabase/server";
import { resolveReferences, type AdReference } from "@/lib/uploads";
import { logoImage, swatchImages, visualImage } from "@/lib/ads/brand-assets";
import { getCampaignResearch } from "@/lib/campaigns";

/**
 * Makes a new version of an ad from the user's feedback: the comments pinned
 * on it (still open) and/or an instruction the agent wrote from the chat.
 *
 * The image before the edit is the base and the only source of truth. The
 * model gets:
 *   1. the ad as it is now (the image to edit),
 *   2. with pinned comments, the same ad with a numbered pin drawn exactly where
 *      pins drawn on a copy: the model copied drawn markers into its output;
 *      see markers.ts), with each pin's position in words.
 * Nothing else: product photos or brand lists would give it a second picture
 * of how things "should" look, and it drifts toward them (a first test
 * re-posed the phone to match a product photo). The prompt lists each change
 * by pin number and position, and that everything else stays as in image 1.
 *
 * Then it checks the result against the image before the edit (retention.ts):
 * did each pinned change happen (the spot changed), and did the rest stay
 * (at least RETRY_BELOW% of the ad outside the pins unchanged, for pins-only
 * edits)? If not, it tries once more with a prompt naming what went wrong
 * and keeps the better attempt (fewest missed pins, then most kept).
 * - Nothing requested happened, even after the retry: no version is made,
 *   and the comments stay open so the user can rephrase them.
 * - Some pins missed: the version is kept, its applied comments are marked
 *   applied, and the missed ones move onto the new version, still open.
 * The share kept is saved on the version (`retained`).
 *
 * The result is a new `campaign_ads` row whose `parent_id` is the version it
 * was edited from; the original stays. The comments it applied are marked
 * "applied" with the new version's id. Never throws.
 */

/**
 * Brand kit items the agent chose to send with an edit (nothing by default,
 * so an edit only sees the ad it changes): the real logo as an image, colors
 * as hex text plus a solid swatch image each, product photos, and the fonts
 * and voice as text.
 */
export type EditInclude = {
  logo?: boolean;
  /** Hex codes from the kit, or "all". */
  colors?: string[] | "all";
  productIds?: string[];
  /** Brand visuals by their number in the kit's list (1-based). */
  visuals?: number[];
  fonts?: boolean;
  voice?: boolean;
};

export type EditAdInput = { adId: string; instruction?: string; references?: AdReference[]; include?: EditInclude };

/** The model takes up to 14 images in all. */
const MAX_IMAGES = 14;

const SIGNED_URL_SECONDS = 15 * 60;
/** Leftover marks are only cleaned up if the edit took less than this (another image must fit the step). */
const CLEANUP_BEFORE_MS = 150_000;
/** A pins-only edit that keeps less than this much of the rest of the ad is retried once. */
const RETRY_BELOW = 90;

export const EDIT_SYSTEM_PROMPT = `You edit finished full-screen 9:16 portrait image ads. You are a retoucher, not a designer: your output is image 1 with the requested changes and nothing else.

Rules for every edit:
- Image 1 is the ad before the edit. Treat it as the base: keep the same framing, layout, camera angle, background, lighting, colors, people and their poses, hands, products and the way they're held, the logo, every piece of text and its typeface, size and position. Everything not named in a requested change must look identical to image 1.
- Image 2, when attached, is a location map, not part of the ad: a black image the same size as image 1 with a numbered white area over each place a requested change applies (numbered like the comments; positions are also given in words). A white disc marks a spot; a white rectangle marks a whole area. Lay it over image 1 in your mind to find each place, and change only what each request asks for, there. Nothing from the location map goes into the ad: never draw white or black areas, pins, circles, numbers, boxes, outlines, arrows, labels or other marks. Return image 1 itself, edited.
- Images listed as references from the user are things to bring into the ad exactly as their note says (an object to add, a style or background to match). Use them only for the requested change.
- Images listed as the brand logo, brand color swatches, brand visuals or product photos come from the brand kit. Use them only where a requested change calls for them (a brand visual's shapes or illustration, not its text or layout): reproduce the logo exactly as in its image (never invent or restyle it, and leave out the plain background its image may sit on), use swatch colors exactly (match the swatch, not a similar shade), and keep products matching their photos. Never draw the swatches themselves.
- Never add invented products, devices, app screens, dashboards, charts or data. Anything the brand sells or shows must match image 1 or the attached reference photos.
- Every requested change must be clearly visible in the result. Returning image 1 unchanged, or skipping a comment, is a failure.
- Keep the headline and call-to-action wording exactly as in image 1, spelled exactly, unless a change explicitly asks for new wording.
- Return the full ad at the same 9:16 size, not a crop.`;

/** A box comment's area (center ± half its size), or undefined for a pin. */
function boxOf(p: { x: number; y: number; w?: number | null; h?: number | null }): Region | undefined {
  if (!p.w || !p.h) return undefined;
  return { left: p.x - p.w / 2, top: p.y - p.h / 2, right: p.x + p.w / 2, bottom: p.y + p.h / 2 };
}

/** What to tell the model on the retry, from what the first attempt got wrong. */
function retryNote(check: EditCheck, drifted: boolean): string {
  const notes: string[] = [];
  if (check.missed.length) {
    const list = check.missed.map((n) => `comment ${n}`).join(", ");
    notes.push(
      `Your previous attempt didn't make the change at ${list}: that spot came back the same as image 1. Make ${check.missed.length === 1 ? "that change" : "those changes"} clearly this time.`,
    );
  } else if (check.unchanged) {
    notes.push("Your previous attempt returned image 1 unchanged. Make the requested change clearly this time.");
  }
  if (drifted) {
    notes.push(
      "Your previous attempt also changed parts of the ad that weren't asked about. Keep everything outside the commented spots exactly as in image 1: same pose, same angle, same positions, same background.",
    );
  }
  return notes.join(" ");
}

/** The better of two attempts: fewer missed changes first, then more of the rest kept. */
function better<T extends { check: EditCheck }>(a: T, b: T): T {
  const missA = a.check.missed.length + (a.check.unchanged ? 1 : 0);
  const missB = b.check.missed.length + (b.check.unchanged ? 1 : 0);
  if (missA !== missB) return missA < missB ? a : b;
  return a.check.kept >= b.check.kept ? a : b;
}

/**
 * An edit, prepared and recorded but not drawn yet: what its own run needs.
 * Plain JSON (it's handed to the edit's workflow run). `temp` are the WebP
 * copies fal reads (the base and the pinned copy), deleted when it ends.
 */
export type EditJob = {
  campaignId: string;
  adId: string;
  parent: { id: string; number: number; headline: string; cta: string; image_path: string };
  /** Open comments, numbered: a spot (pin) or an area (box, `w`/`h`). */
  pins: { id: string; x: number; y: number; w: number | null; h: number | null; body: string; n: number }[];
  instruction?: string;
  prompt: string;
  imageUrls: string[];
  temp: string[];
};

/** Prepares the edit, then makes it (the in-process flow; the agent splits the two across runs). */
export async function editAd(
  campaignId: string,
  input: EditAdInput,
  ctx: { toolCallId?: string; runId?: string } = {},
): Promise<AdToolResult> {
  const prepared = await prepareEdit(campaignId, input, ctx);
  return "result" in prepared ? prepared.result : runEdit(prepared.job);
}

/**
 * Everything before the image work, in a few seconds: checks the request
 * (the ad exists and is finished, there's something to change, attached
 * images exist), uploads the copies fal reads, writes the prompt and records
 * the new version as "generating". A mistake comes back as `{ result }` for
 * the agent. `runId` is the agent run asking: if it was stopped meanwhile,
 * nothing is recorded.
 */
export async function prepareEdit(
  campaignId: string,
  input: EditAdInput,
  ctx: { toolCallId?: string; runId?: string } = {},
): Promise<{ result: AdToolResult } | { job: EditJob }> {
  const temp: string[] = [];
  const removeTemp = () =>
    temp.length ? supabase().storage.from(AD_BUCKET).remove(temp).then(() => undefined, () => undefined) : undefined;
  try {
    const prepared = await prepare(campaignId, input, ctx, temp);
    if ("result" in prepared) await removeTemp();
    return prepared;
  } catch (error) {
    await removeTemp();
    throw error;
  }
}

async function prepare(
  campaignId: string,
  input: EditAdInput,
  { toolCallId, runId }: { toolCallId?: string; runId?: string },
  temp: string[],
): Promise<{ result: AdToolResult } | { job: EditJob }> {
  const fail = (summary: string) => ({ result: { ok: false, summary } });
  const db = supabase();
  const { data: parent } = await db
    .from("campaign_ads")
    .select("id, number, headline, cta, product_ids, status, image_path")
    .eq("campaign_id", campaignId)
    .eq("id", input.adId)
    .maybeSingle();
  if (!parent) return fail("Couldn't edit that ad: it doesn't exist (it may have been deleted).");
  const label = `“${parent.headline}”`;
  if (parent.status !== "ready" || !parent.image_path) {
    return fail(`Couldn't edit the ad for ${label}: it isn't finished.`);
  }
  if (!falCredentials()) return fail(`Couldn't edit the ad for ${label}: image generation isn't configured.`);

  const done = await finishedByToolCall(toolCallId);
  if (done) return { result: adResult(campaignId, done.id, done.headline, done.cta, done.image_path, `Edited the ad for ${label}.`) };

  const { data: comments } = await db
    .from("ad_comments")
    .select("id, x, y, w, h, body")
    .eq("ad_id", parent.id)
    .eq("status", "open")
    .order("created_at");
  const pins = (comments ?? []).map((c, i) => ({ ...c, n: i + 1 }));
  const instruction = input.instruction?.trim();
  if (!pins.length && !instruction) {
    return fail(`Nothing to change on the ad for ${label}: it has no open comments and no instruction.`);
  }

  // The image before the edit, and (with comments) a pinned copy, as
  // short-lived signed URLs fal can fetch from our private bucket.
  const bucket = db.storage.from(AD_BUCKET);
  const original = await bucket.download(parent.image_path);
  if (original.error || !original.data) return fail(`Couldn't edit the ad for ${label}: its image is missing.`);
  const before = new Uint8Array(await original.data.arrayBuffer());
  // fal reads a WebP copy of the base (about 1 MB instead of the 4 MB PNG,
  // and a retry reads it again); the ad's inputs still record the PNG.
  const token = toolCallId ?? randomUUID();
  const basePath = `${campaignId}/edit-${token}.webp`;
  temp.push(basePath);
  const base = await bucket.upload(basePath, await workWebp(before), { contentType: WEBP, upsert: true });
  if (base.error) return fail(`Couldn't edit the ad for ${label}: preparing its image failed.`);
  const imagePaths = [basePath];
  // With comments: a copy with a numbered pin exactly where each was placed.
  // A pin the model copies into the result is caught and removed afterwards
  // (the leftover-mark check below).
  if (pins.length) {
    const marked = await drawLocationMap(before, pins.map((p) => ({ n: p.n, x: p.x, y: p.y, box: boxOf(p) })));
    const markPath = `${campaignId}/marks-${token}.webp`;
    temp.push(markPath);
    const upload = await bucket.upload(markPath, marked, { contentType: WEBP, upsert: true });
    if (upload.error) return fail(`Couldn't edit the ad for ${label}: preparing the comments failed.`);
    imagePaths.push(markPath);
  }
  const signed = await bucket.createSignedUrls(imagePaths, SIGNED_URL_SECONDS);
  const adUrls = (signed.data ?? []).map((s) => s.signedUrl).filter((u): u is string => Boolean(u));
  if (signed.error || adUrls.length !== imagePaths.length) {
    return fail(`Couldn't edit the ad for ${label}: preparing its image failed.`);
  }
  // After ours: the brand kit items the agent chose, then images the user
  // attached in chat, while there's room.
  const refs = await resolveReferences(campaignId, input.references);
  if (refs.missing.length) {
    return fail(`Couldn't edit the ad for ${label}: no attached image called ${refs.missing.map((m) => `"${m}"`).join(", ")}.`);
  }
  const kitImages = await brandKitImages(campaignId, input.include);
  const imageUrls = [...adUrls];
  // Recorded by storage path: the ad it edits (its PNG) and, with pins, the
  // pinned copy (a temporary file, deleted when the edit ends).
  const recordedInputs = [parent.image_path, ...imagePaths.slice(1)].map((p) => `${AD_BUCKET}/${p}`);
  const add = (img: { url: string; recorded: string }) => {
    if (imageUrls.length >= MAX_IMAGES) return undefined;
    recordedInputs.push(img.recorded);
    return `image ${imageUrls.push(img.url)}`;
  };
  const imageLines: string[] = [];
  const logoRef = kitImages.logo ? add(kitImages.logo) : undefined;
  if (logoRef) imageLines.push(`${logoRef}: the brand logo (the real one; reproduce it exactly where a change calls for it)`);
  const visualRefs = kitImages.visuals.flatMap((v) => {
    const image = add(v);
    if (image) imageLines.push(`${image}: brand visual V${v.n}, the brand's own graphic (${v.description}); use its shapes or illustration where a change calls for it, not its text or layout`);
    return image ? [{ image, description: v.description }] : [];
  });
  const productRefs = kitImages.products.flatMap((p) => {
    const image = add(p);
    if (image) imageLines.push(`${image}: product photo of ${p.title}`);
    return image ? [{ image, name: p.title }] : [];
  });
  const referenceList = refs.found.flatMap((r) => {
    const image = add(r);
    if (image) imageLines.push(`${image}: a reference from the user (${r.use})`);
    return image ? [{ image, use: r.use }] : [];
  });
  const colorList = kitImages.swatches.map((sw) => {
    const image = add(sw);
    if (image) imageLines.push(`${image}: brand color swatch ${sw.hex} (${sw.role}), a solid square of that exact color`);
    return { hex: sw.hex, role: sw.role, use_for: sw.use, ...(image && { swatch: image }) };
  });
  const brandKit = {
    ...(logoRef && { logo: logoRef }),
    ...(colorList.length && { colors: colorList }),
    ...(productRefs.length && { products: productRefs }),
    ...(visualRefs.length && { brand_visuals: visualRefs }),
    ...(kitImages.fonts.length && { fonts: kitImages.fonts }),
    ...(kitImages.voice && { voice: kitImages.voice }),
  };

  const changes = {
    changes: pins.map((p) => {
      const box = boxOf(p);
      return {
        comment: p.n,
        where: box
          ? `white area ${p.n} on the location map (image 2): the area ${describeRegion(box)}`
          : `white disc ${p.n} on the location map (image 2): the spot about ${Math.round(p.x * 100)}% from the left and ${Math.round(p.y * 100)}% from the top`,
        request: p.body,
      };
    }),
    ...(instruction && { overall_request: instruction }),
    ...(referenceList.length && { user_references: referenceList }),
    ...(Object.keys(brandKit).length && { brand_kit: brandKit }),
    keep_exactly: {
      headline: parent.headline,
      call_to_action: parent.cta,
      everything_else: "as in image 1",
    },
  };
  const prompt = `Edit image 1. Attached images, in order:
- image 1: the ad before the edit (the base; return this image, edited, and keep everything not requested exactly as it is)
${pins.length ? "- image 2: a location map, not part of the ad: black, with a numbered white area over each place a change applies\n" : ""}${imageLines.map((line) => `- ${line}\n`).join("")}
Requested changes (JSON):
${JSON.stringify(changes, null, 2)}

Change only what is requested. Return the whole of image 1, with nothing from the location map drawn in it.`;

  // What this version applied, in words, for the version history.
  const applied = [...pins.map((p) => `${p.n}. ${p.body}`), ...(instruction ? [instruction] : [])].join("\n");

  let adId: string;
  try {
    ({ id: adId } = await startAdRow({
      campaign_id: campaignId,
      headline: parent.headline,
      cta: parent.cta,
      product_ids: parent.product_ids ?? [],
      prompt,
      system_prompt: EDIT_SYSTEM_PROMPT,
      // Our own images are recorded by storage path, never as signed URLs.
      image_inputs: recordedInputs,
      parent_id: parent.id,
      instruction: applied,
      tool_call_id: toolCallId ?? null,
      run_id: null,
    }));
    if (runId && (await runStopped(campaignId, runId))) {
      await db.from("campaign_ads").delete().eq("id", adId);
      throw new AdStoppedError();
    }
  } catch (error) {
    if (error instanceof AdStoppedError) return fail(`Stopped editing the ad for ${label}.`);
    console.error("[ads] saving the edit row failed", error);
    return fail(`Couldn't edit the ad for ${label}: saving it failed.`);
  }
  const pinned = pins.length ? `${pins.length} ${pins.length === 1 ? "comment" : "comments"}` : "";
  await setAdStage(campaignId, adId, `Applying ${[pinned, instruction && "your change"].filter(Boolean).join(" and ")}`);

  return {
    job: {
      campaignId,
      adId,
      parent: { id: parent.id, number: parent.number, headline: parent.headline, cta: parent.cta, image_path: parent.image_path },
      pins,
      instruction,
      prompt,
      imageUrls,
      temp,
    },
  };
}

/**
 * Makes a prepared edit: the image, its checks and retry, leftover-mark
 * cleanup, storing it and marking the comments it applied. `runId` is the run
 * making it, recorded on the row for the stale-ad sweep. The temporary copies
 * are deleted however it ends. Never throws.
 */
export async function runEdit(job: EditJob, runId?: string): Promise<AdToolResult> {
  try {
    return await makeEdit(job, runId);
  } finally {
    if (job.temp.length) await supabase().storage.from(AD_BUCKET).remove(job.temp).catch(() => undefined);
  }
}

async function makeEdit(job: EditJob, runId?: string): Promise<AdToolResult> {
  const { campaignId, adId, parent, pins, instruction, prompt, imageUrls } = job;
  const label = `“${parent.headline}”`;
  const db = supabase();

  const startedAt = Date.now();
  try {
    if (runId) {
      await db.from("campaign_ads").update({ run_id: runId }).eq("id", adId).eq("status", "generating");
    }
    await throwIfStopped(adId); // stopped before it started: don't pay for the image
    // The image before the edit: the checks compare the result with it.
    const original = await db.storage.from(AD_BUCKET).download(parent.image_path);
    if (original.error || !original.data) throw new Error("the ad's image went missing");
    const before = new Uint8Array(await original.data.arrayBuffer());
    // Check against the image before the edit. With an overall request the
    // whole ad may legitimately change, so drift only counts for pins-only edits.
    const attempt = async (extra?: string) => {
      const image = await falImage(
        { prompt: extra ? `${prompt}\n\n${extra}` : prompt, systemPrompt: EDIT_SYSTEM_PROMPT, imageUrls },
        adId,
      );
      return { image, check: await checkEdit(before, image.bytes, pins) };
    };
    const failed = (c: EditCheck) => c.missed.length > 0 || (!pins.length && c.unchanged);
    const drifted = (c: EditCheck) => !instruction && c.kept < RETRY_BELOW;

    let best: { image: FalImage; check: EditCheck } = await attempt();
    let tries = 1;
    if (failed(best.check) || drifted(best.check)) {
      console.warn(`[ads] edit check: missed ${JSON.stringify(best.check.missed)}, kept ${best.check.kept}%; retrying`);
      tries = 2;
      await throwIfStopped(adId); // don't pay for a retry the user stopped
      await setAdStage(
        campaignId,
        adId,
        best.check.missed.length
          ? `Trying the edit again: ${best.check.missed.length === 1 ? "a comment" : "some comments"} didn't take`
          : failed(best.check)
            ? "Trying the edit again: nothing changed"
            : "Trying the edit again: it changed more than asked",
      );
      const second = await attempt(retryNote(best.check, drifted(best.check))).catch(() => null);
      if (second) best = better(best, second);
    }
    const { kept, missed } = best.check;

    // Nothing requested happened: don't make an identical version.
    // With an instruction too, the ad still counts as unchanged if nothing
    // anywhere changed (the model returned image 1).
    const nothingApplied = pins.length
      ? missed.length === pins.length && (!instruction || best.check.unchanged)
      : best.check.unchanged;
    if (nothingApplied) {
      await throwIfStopped(adId);
      // Kept as a failed version with the reason, so the chat and the studio
      // can say what happened (the edit runs on its own, after the reply).
      const summary = `The image model returned the ad for ${label} unchanged${tries > 1 ? ", twice" : ""}, so no new version was made. The comments are still open: try describing the change more specifically (say what should be there instead).`;
      await failAdRow(adId, summary);
      return { ok: false, summary };
    }

    // Leftover marks (numbers, discs, boxes or pins from the location map the
    // model drew into the ad): a removal edit, up to twice, each kept only if
    // it leaves fewer. A version that still has one is never saved.
    let image = best.image;
    let marks = await findArtifacts(image.bytes);
    for (let attempt = 1; marks.length && attempt <= 2 && Date.now() - startedAt < CLEANUP_BEFORE_MS; attempt++) {
      console.warn(`[ads] edit left ${marks.length} mark(s); removing (attempt ${attempt})`);
      await throwIfStopped(adId);
      await setAdStage(campaignId, adId, "Removing leftover marks");
      const box = {
        left: Math.min(...marks.map((m) => m.box.left)),
        top: Math.min(...marks.map((m) => m.box.top)),
        right: Math.max(...marks.map((m) => m.box.right)),
        bottom: Math.max(...marks.map((m) => m.box.bottom)),
      };
      const cleaned = await fixAd({
        campaignId,
        adId,
        draft: image,
        issues: [{
          kind: "artifact",
          problem: `Leftover marks: ${marks.map((m) => m.where).join("; ")}.`,
          fix: "Remove every one of these marks completely and fill each spot with what would naturally be behind it.",
          where: marks.map((m) => m.where).join("; "),
          box,
          x: (box.left + box.right) / 2,
          y: (box.top + box.bottom) / 2,
        }],
        productUrls: [],
        headline: parent.headline,
        cta: parent.cta,
      }).catch((error) => {
        console.error("[ads] removing leftover marks failed", error);
        return null;
      });
      if (!cleaned) continue;
      const left = await findArtifacts(cleaned.bytes);
      if (left.length < marks.length) {
        image = cleaned;
        marks = left;
      }
    }
    if (marks.length) {
      await throwIfStopped(adId);
      const summary = `The image model drew a marker into the edited ad for ${label} (${marks.map((m) => m.where).join("; ")}) and it couldn't be removed, so no version was saved. The comments are still open: apply them again.`;
      console.warn(`[ads] edit kept ${marks.length} mark(s); not saving it`);
      await failAdRow(adId, summary);
      return { ok: false, summary };
    }

    const { path } = await storeAdImage(campaignId, adId, image, { retained: kept });

    // What the edit actually did, from the before and after images, for the
    // version's "Changes" and the agent's reply.
    const changes = await summarizeEdit({
      before,
      after: image.bytes,
      requests: [...pins.map((p) => p.body), ...(instruction ? [instruction] : [])],
    });
    const { count: versionCount } = await db
      .from("campaign_ads")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("number", parent.number)
      .eq("status", "ready");
    if (changes.length) await db.from("campaign_ads").update({ changes }).eq("id", adId);
    const appliedPins = pins.filter((p) => !missed.includes(p.n));
    if (appliedPins.length) {
      await db
        .from("ad_comments")
        .update({ status: "applied", applied_ad_id: adId })
        .in(
          "id",
          appliedPins.map((p) => p.id),
        );
    }
    // Comments whose change didn't show up move to the new version, still
    // open (the layout is the same, so their spots still fit).
    if (missed.length) {
      await db
        .from("ad_comments")
        .update({ ad_id: adId })
        .in(
          "id",
          pins.filter((p) => missed.includes(p.n)).map((p) => p.id),
        );
    }

    const what = [
      appliedPins.length && `${appliedPins.length} comment${appliedPins.length === 1 ? "" : "s"}`,
      instruction && "your note",
    ]
      .filter(Boolean)
      .join(" and ");
    const notes = [
      missed.length
        ? `The change at ${missed.map((n) => `pin ${n}`).join(", ")} didn't show up${tries > 1 ? " after a retry" : ""}; ${missed.length === 1 ? "that comment is" : "those comments are"} still open on the new version.`
        : "",
      !instruction && kept < RETRY_BELOW ? `It changed more of the ad than asked (kept ${Math.round(kept)}% of the rest).` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const did = changes.length
      ? `: ${changes.map((c, i) => (i ? c.charAt(0).toLowerCase() + c.slice(1) : c)).join("; ")}.`
      : ` with ${what}.`;
    return adResult(
      campaignId,
      adId,
      parent.headline,
      parent.cta,
      path,
      `Made v${versionCount ?? "?"} of Ad ${parent.number}${did}${notes ? ` ${notes}` : ""}`,
      changes,
    );
  } catch (error) {
    if (error instanceof AdStoppedError) return { ok: false, summary: `Stopped editing the ad for ${label}.` };
    const reason = error instanceof Error ? error.message : "the image service failed";
    console.error("[ads] edit failed", reason);
    await failAdRow(adId, reason);
    return { ok: false, summary: `Couldn't edit the ad for ${label}: ${reason}` };
  } finally {
    // Done either way (ready, failed, unchanged or stopped): update the Campaigns list.
    await broadcastAdActivity(campaignId);
  }
}

/**
 * The brand kit items an edit asked for, ready for fal: the logo (PNG),
 * swatches for the chosen colors, one photo per chosen product (only ones
 * that load), and the fonts and voice as text. Nothing when nothing's asked.
 */
async function brandKitImages(campaignId: string, include?: EditInclude) {
  const none = {
    logo: null,
    swatches: [] as Awaited<ReturnType<typeof swatchImages>>,
    products: [] as { url: string; recorded: string; title: string }[],
    visuals: [] as { url: string; recorded: string; description: string; n: number }[],
    fonts: [] as string[],
    voice: undefined as { traits?: string[]; description?: string } | undefined,
  };
  if (!include || !Object.values(include).some((v) => (Array.isArray(v) ? v.length : Boolean(v)))) return none;
  const kit = (await getCampaignResearch(campaignId).catch(() => null))?.kit;
  if (!kit) return none;

  const picked = include.colors;
  const wanted =
    picked === "all"
      ? kit.colors
      : kit.colors.filter((c) => (picked ?? []).some((h) => h.trim().toUpperCase() === c.hex.toUpperCase()));
  const [logo, swatches, products] = await Promise.all([
    include.logo ? logoImage(campaignId, kit.logo) : null,
    wanted.length ? swatchImages(campaignId, wanted) : [],
    include.productIds?.length ? chooseProducts(kit, include.productIds, false) : [],
  ]);
  // Generated visuals live in our private bucket and are signed for the model.
  const visuals = (
    await Promise.all(
      (include.visuals ?? []).map(async (n) => {
        const v = kit.visuals?.[n - 1];
        const image = v ? await visualImage(v) : null;
        return v && image ? { ...image, description: v.description, n } : null;
      }),
    )
  ).filter((v) => v !== null);
  return {
    logo,
    swatches,
    products: products.map((p) => ({ url: p.images[0], recorded: p.images[0], title: p.title })),
    visuals,
    fonts: include.fonts ? kit.fonts.map((f) => `${f.family} (${f.role})`) : [],
    voice: include.voice ? { traits: kit.voice?.traits, description: kit.voice?.summary } : undefined,
  };
}
