import "server-only";

import { randomUUID } from "node:crypto";

import { generateText, Output } from "ai";
import sharp from "sharp";
import { z } from "zod";

import { drawMarkers } from "@/lib/ads/markers";
import { falImage, type FalImage } from "@/lib/ads/render";
import { AD_BUCKET } from "@/lib/ads/store";
import { supabase } from "@/lib/supabase/server";

/**
 * Checks a freshly generated ad before anyone sees it, and fixes it when it's
 * wrong. Image models redraw logos and sometimes invent products or app
 * screens; this catches that:
 *
 * - `verifyAd`: a vision model compares the ad with the brand's real logo
 *   and the real product photos (or screenshots, for services) and lists
 *   each problem: a wrong, garbled or missing logo, a fake or altered
 *   product, or an invented screen/dashboard, with where it is and how to
 *   fix it. Strict on those three things, blind to styling.
 * - `fixAd`: one Nano Banana edit of the ad with the real logo and products
 *   attached and a marker on each problem, under retoucher rules (change
 *   only what's wrong, keep the rest).
 *
 * The model is VERIFY_MODEL, defaulting to the agent's model: this is a
 * careful visual comparison, so it gets the stronger one.
 */

export const VERIFY_MODEL =
  process.env.VERIFY_MODEL ?? process.env.AGENT_MODEL ?? process.env.RESEARCH_MODEL ?? "anthropic/claude-sonnet-5.5";

export type AdIssue = {
  kind: "logo" | "fake_product" | "fake_screen";
  /** What's wrong, in a short sentence. */
  problem: string;
  /** What the fix should do, as an instruction to the image model. */
  fix: string;
  /** Where it is in the ad, as fractions of width and height. */
  x: number;
  y: number;
};

const issueSchema = z.object({
  issues: z
    .array(
      z.object({
        kind: z
          .enum(["logo", "fake_product", "fake_screen"])
          .describe(
            "logo: the ad's logo differs from the real logo (shape, letterforms, colors, an added or missing wordmark), is garbled, or is missing. fake_product: a product that isn't one of the reference products, or a reference product with a changed design, print or color. fake_screen: a screen, dashboard, app interface, chart or data that isn't one of the reference screenshots.",
          ),
        problem: z.string().describe("What's wrong, in one short sentence."),
        fix: z
          .string()
          .describe(
            "An instruction for an image editor that fixes it, e.g. 'Replace the logo at the top with the real logo from the reference, same position and size' or 'Remove the invented dashboard on the laptop screen; show the real screenshot from the reference instead'.",
          ),
        x: z.number().min(0).max(1).describe("Horizontal center of the problem, 0 = left edge, 1 = right edge."),
        y: z.number().min(0).max(1).describe("Vertical center of the problem, 0 = top, 1 = bottom."),
      }),
    )
    .max(5)
    .describe("Every problem found. Empty when the logo and products are right."),
});

/** Shrinks an image for the model; transparent logos go on grey so both light and dark marks show. */
async function prepare(image: Uint8Array, size: number, flatten = false) {
  const img = sharp(image).resize(size, size, { fit: "inside", withoutEnlargement: true });
  return (flatten ? img.flatten({ background: "#9e9e9e" }) : img).jpeg({ quality: 85 }).toBuffer();
}

async function download(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

export type VerifyInput = {
  image: Uint8Array;
  /** The real logo (a URL fal and we can fetch), when the brand has one. */
  logoUrl?: string;
  /** The real product photos (or service screenshots) the ad was made from. */
  productUrls: string[];
  services: boolean;
};

/** The problems a vision model finds in the ad. Never throws: on failure it reports none (and logs). */
export async function verifyAd(input: VerifyInput): Promise<{ checked: boolean; issues: AdIssue[] }> {
  try {
    const [ad, logo, products] = await Promise.all([
      prepare(input.image, 1024),
      input.logoUrl ? download(input.logoUrl).then((b) => (b ? prepare(b, 512, true) : null)) : Promise.resolve(null),
      Promise.all(input.productUrls.slice(0, 6).map((u) => download(u).then((b) => (b ? prepare(b, 512) : null)))),
    ]);
    const refs = products.filter((p) => p !== null);
    const content = [
      { type: "text" as const, text: "Image 1: the generated ad to check." },
      { type: "file" as const, data: ad, mediaType: "image/jpeg" },
      ...(logo
        ? [
            { type: "text" as const, text: "The brand's real logo (shown on grey):" },
            { type: "file" as const, data: logo, mediaType: "image/jpeg" },
          ]
        : []),
      ...refs.flatMap((p, i) => [
        {
          type: "text" as const,
          text: `Reference ${input.services ? "screenshot or photo of the service" : "product photo"} ${i + 1}:`,
        },
        { type: "file" as const, data: p, mediaType: "image/jpeg" },
      ]),
      {
        type: "text" as const,
        text: `Check the ad. ${
          logo
            ? "Logo: it must be the real logo above, exactly (same mark, letterforms, colors, no added or missing wordmark), legible and not garbled. A missing logo is a problem too."
            : "There is no reference logo; don't report logo problems."
        } Products: everything the brand sells that appears must be one of the references, unchanged.${
          input.services
            ? " This brand sells a service: any screen, dashboard or interface must be one of the reference screenshots; an invented one is a problem."
            : " An invented screen or dashboard is a problem too."
        } Ignore the background, people, props, lighting, colors, text and layout: only the logo, products and screens matter. List each problem with its location.`,
      },
    ];
    const { output } = await generateText({
      model: VERIFY_MODEL,
      instructions:
        "You are a strict brand-safety checker for ads made by an image model. You compare the ad with the brand's real logo and real product references and report only real problems: a logo that isn't the real one, a fake or altered product, or an invented screen. Don't report style choices, and don't report something you can't see clearly.",
      messages: [{ role: "user", content }],
      output: Output.object({ schema: issueSchema }),
    });
    return { checked: true, issues: output.issues.filter((i) => logo || i.kind !== "logo") };
  } catch (error) {
    console.error("[ads] verifying the ad failed", error);
    return { checked: false, issues: [] };
  }
}

const FIX_SYSTEM_PROMPT = `You repair finished full-screen 9:16 portrait image ads. You are a retoucher: your output is image 1 with the listed problems fixed and nothing else changed.

Rules:
- Image 1 is the ad. Keep its framing, layout, background, lighting, people and poses, every piece of text with its wording, typeface, size and position, and everything not named in a fix, identical.
- Image 2 is image 1 with numbered pink circles on each problem. They're only a guide: never draw circles or numbers.
- The brand logo image, when attached, is the real logo: where a fix concerns the logo, reproduce it exactly as in that image (same mark, letterforms, colors, proportions), at the same position and a similar size, and remove any wrong logo or wordmark.
- Product photos or screenshots, when attached, are the real ones: where a fix concerns a product or screen, make it match them exactly, or remove what isn't real. Never invent a product, screen, dashboard or data.
- Return the full ad at the same 9:16 size, not a crop.`;

/**
 * One repair pass: Nano Banana edits the ad with markers on each problem and
 * the real logo and product references attached. The draft and its marked
 * copy go to fal as short-lived signed URLs from our bucket.
 */
export async function fixAd(input: {
  campaignId: string;
  adId: string;
  draft: FalImage;
  issues: AdIssue[];
  logoUrl?: string;
  productUrls: string[];
  headline: string;
  cta: string;
}): Promise<FalImage> {
  const bucket = supabase().storage.from(AD_BUCKET);
  const pins = input.issues.map((issue, i) => ({ n: i + 1, x: issue.x, y: issue.y }));
  const token = randomUUID();
  const draftPath = `${input.campaignId}/check-${input.adId}-${token}.png`;
  const markPath = `${input.campaignId}/marks-check-${input.adId}-${token}.png`;
  try {
    const marked = await drawMarkers(input.draft.bytes, pins);
    const [a, b] = await Promise.all([
      bucket.upload(draftPath, input.draft.bytes, { contentType: "image/png", upsert: true }),
      bucket.upload(markPath, marked, { contentType: "image/png", upsert: true }),
    ]);
    if (a.error || b.error) throw a.error ?? b.error;
    const signed = await bucket.createSignedUrls([draftPath, markPath], 15 * 60);
    const [draftUrl, markUrl] = (signed.data ?? []).map((s) => s.signedUrl);
    if (!draftUrl || !markUrl) throw new Error("couldn't sign the draft");

    const needsLogo = input.issues.some((i) => i.kind === "logo") && input.logoUrl;
    const needsProducts = input.issues.some((i) => i.kind !== "logo");
    const imageUrls = [draftUrl, markUrl];
    const lines = ["image 1: the ad to repair", "image 2: the same ad with numbered markers on each problem (guide only)"];
    if (needsLogo) lines.push(`image ${imageUrls.push(input.logoUrl!)}: the brand's real logo`);
    if (needsProducts) {
      for (const url of input.productUrls.slice(0, 6)) lines.push(`image ${imageUrls.push(url)}: a real product photo or screenshot`);
    }
    const fixes = {
      fixes: input.issues.map((issue, i) => ({
        marker: i + 1,
        where: `about ${Math.round(issue.x * 100)}% from the left and ${Math.round(issue.y * 100)}% from the top`,
        problem: issue.problem,
        fix: issue.fix,
      })),
      keep_exactly: { headline: input.headline, call_to_action: input.cta, everything_else: "as in image 1" },
    };
    const prompt = `Repair image 1. Attached images, in order:
${lines.map((l) => `- ${l}`).join("\n")}

Problems to fix (JSON):
${JSON.stringify(fixes, null, 2)}

Fix only these. Don't draw the markers.`;
    return await falImage({ prompt, systemPrompt: FIX_SYSTEM_PROMPT, imageUrls }, input.adId);
  } finally {
    await bucket.remove([draftPath, markPath]).catch(() => undefined);
  }
}

/** One line on what the check found, for the chat ("a made-up logo and an invented dashboard"). */
export function describeIssues(issues: AdIssue[]): string {
  const kinds = [...new Set(issues.map((i) => i.kind))].map((k) =>
    k === "logo" ? "a logo that didn't match the real one" : k === "fake_product" ? "a product that wasn't real" : "an invented screen",
  );
  return kinds.length > 1 ? `${kinds.slice(0, -1).join(", ")} and ${kinds.at(-1)}` : (kinds[0] ?? "");
}
