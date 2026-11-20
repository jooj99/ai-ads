import "server-only";

import { randomUUID } from "node:crypto";

import { generateText, Output } from "ai";
import sharp from "sharp";
import { z } from "zod";

import { describeRegion, drawMarkers } from "@/lib/ads/markers";
import { falImage, type FalImage } from "@/lib/ads/render";
import { AD_BUCKET } from "@/lib/ads/store";
import { supabase } from "@/lib/supabase/server";

/**
 * Checks a freshly generated ad before anyone sees it, and repairs it when
 * it's wrong. Image models redraw logos and sometimes invent or alter
 * products and app screens; this catches that:
 *
 * - `verifyAd`: a vision model compares the draft with the real product
 *   photos (or screenshots, for services) and the brand's real logo, and
 *   lists each problem: a logo that isn't the real one (on the ad or on a
 *   product), a logo that looks pasted on in a box, a fake or altered
 *   product, or an invented screen. Each comes with the box around it,
 *   what's in that box, and how to fix it. Strict on those, blind to styling.
 * - `fixAd`: one Nano Banana edit for one problem: the draft plus a copy with
 *   a numbered box around the problem, the box's position in words, and the
 *   real references it needs, under retoucher rules (change only inside the
 *   box). The generation flow chains one per problem, up to three rounds,
 *   checking after each round (lib/ads/flow.ts).
 *
 * The model is VERIFY_MODEL, defaulting to the agent's model: this is a
 * careful visual comparison, so it gets the stronger one.
 */

export const VERIFY_MODEL =
  process.env.VERIFY_MODEL ?? process.env.AGENT_MODEL ?? process.env.RESEARCH_MODEL ?? "anthropic/claude-sonnet-5.5";

export type AdIssueKind = "logo" | "logo_box" | "fake_product" | "fake_screen" | "artifact" | "copy";

export type AdIssue = {
  kind: AdIssueKind;
  /** What's wrong, in a short sentence. */
  problem: string;
  /** What the fix should do, as an instruction to the image model. */
  fix: string;
  /** What's in the box, e.g. "the phone case in the woman's right hand". */
  where: string;
  /** Center of the problem, as fractions of width and height. */
  x: number;
  y: number;
  /** The area around it, as fractions (left, top, right, bottom). */
  box: { left: number; top: number; right: number; bottom: number };
};

const fraction = z.number().min(0).max(1);
const issueSchema = z.object({
  issues: z
    .array(
      z.object({
        kind: z
          .enum(["logo", "logo_box", "fake_product", "fake_screen", "artifact", "copy"])
          .describe(
            "logo: a logo in the ad (the ad's own logo, or one printed on a product, packaging or sign) that differs from the real logo or the product photos (shape, letterforms, colors, an added or missing wordmark), is garbled, or is missing (the ad should show the real logo). logo_box: the logo itself is right but looks pasted on: it sits in a box, panel, sticker or patch of solid color (often white or black) that isn't part of the ad's design, instead of being printed directly on the ad's background. fake_product: a product that isn't one of the reference products, or a reference product with anything changed: its color, print or pattern, shape, or a part moved, added, removed or attached differently (a grip loop, strap, handle, button, cutout or badge in a different place or form), or shown using a part it doesn't have (a strap it lacks, a loop where there is none). How it's held, worn or used, and the setting around it, are free: any use of its real parts is fine. fake_screen: a screen, dashboard, app interface, chart or data that isn't one of the reference screenshots. artifact: a leftover editing mark that isn't part of the design: a numbered circle or dot, a pin, a box drawn around something, an arrow, a label, stray digits or a watermark. copy: the headline or call-to-action isn't exactly the given text (a repeated, missing, extra or misspelled word, or it appears twice).",
          ),
        problem: z.string().describe("What's wrong, in one short sentence."),
        fix: z
          .string()
          .describe(
            "An instruction for an image editor that fixes it inside the box, e.g. 'Recolor the case to the cream of the reference with its black bow print' or 'Replace the logo with the real logo from the reference, same position and size'.",
          ),
        where: z.string().describe("What's in the box and where, in a few words, e.g. 'the phone case in the woman's right hand, center of the ad'."),
        left: fraction.describe("Left edge of the tight box around the problem (the whole object), 0 = left edge of the ad."),
        top: fraction.describe("Top edge of the box, 0 = top of the ad."),
        right: fraction.describe("Right edge of the box, 1 = right edge of the ad."),
        bottom: fraction.describe("Bottom edge of the box, 1 = bottom of the ad."),
      }),
    )
    .max(6)
    .describe("Every problem found. Empty when everything checked is right."),
});

/** Shrinks an image for the model; a transparent logo goes on grey so both light and dark marks show. */
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
  /** The brand's real logo (a URL we can fetch), when it has one. */
  logoUrl?: string;
  /** The real product photos (or service screenshots) the ad was made from. */
  productUrls: string[];
  services: boolean;
  /** False when the ad intentionally doesn't show the product (its images were only a style reference). */
  productShown?: boolean;
  /** The exact copy the ad must show, when known. */
  headline?: string;
  cta?: string;
};

/** The problems a vision model finds in the draft. Never throws: on failure it reports none (and logs). */
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
            ? "Logo: the ad's logo must be the real logo above, exactly (same mark, letterforms, colors, no added or missing wordmark), legible and not garbled; a missing logo is a problem too. Logos printed on products must match the real logo and the product photos. It must also sit directly on the ad like printed artwork: the reference is shown on a plain background only so it's visible, so a box, panel or patch of solid color behind the ad's logo that doesn't belong to the design is a logo_box problem."
            : "Logo: there's no reference logo; only report a logo printed on a product that doesn't match the product photos."
        } ${
          input.productShown === false
            ? "This ad intentionally doesn't show the product: the references above are only its visual style. Abstract shapes, patterns and illustrations are fine and are not products. Only report something that's presented as one of the brand's products, devices or interfaces and isn't real (fake_product / fake_screen)."
            : "Products: everything the brand sells that appears must be one of the references, unchanged."
        } Compare each product in the ad with its reference photos part by part: base color, print or pattern and its colors, shape and proportions, and every part: where it sits, its size and how it attaches (for example a finger loop lying flat down the middle of a case's back, not a strap hanging from its top edge), plus cutouts. Don't report how it's held, worn, dangled or used, or the setting: staging is free, as long as it only uses parts the product really has. Each difference is its own fake_product problem; a product that's right except one moved part is still wrong.${
          input.services
            ? " This brand sells a service: any screen, dashboard or interface must be one of the reference screenshots; an invented one is a problem."
            : " An invented screen or dashboard is a problem too."
        } ${
          input.headline
            ? `Copy: the headline must read exactly "${input.headline}" and the button exactly "${input.cta ?? ""}", each once; a repeated, missing, extra or misspelled word is a copy problem (box the text). `
            : ""
        }Also report every leftover editing mark (numbered circles or dots, pins, drawn boxes, arrows, labels, stray digits, watermarks) as an artifact, each with its own box. Otherwise ignore the background, people, props, lighting, colors, the headline, the button and the layout. For each problem give the tight box around the object that's wrong and say what's in it.`,
      },
    ];
    const { output } = await generateText({
      model: VERIFY_MODEL,
      instructions:
        "You are a strict brand-safety checker for ads made by an image model. You compare the ad with the brand's real logo and real product references and report only real problems: a logo that isn't the real one or looks pasted on, a fake or altered product, or an invented screen. Look at products closely: image models often keep a product's general look but recolor it, or move, reshape or reinvent one of its parts; those are real problems. Creative staging (a new setting, pose or way of using it) is intended, not a problem. Locate each problem precisely. Don't report style choices, and don't report something you can't see clearly.",
      messages: [{ role: "user", content }],
      output: Output.object({ schema: issueSchema }),
    });
    const issues = output.issues.map(({ left, top, right, bottom, ...issue }): AdIssue => {
      const box = {
        left: Math.min(left, right),
        top: Math.min(top, bottom),
        right: Math.max(left, right),
        bottom: Math.max(top, bottom),
      };
      return { ...issue, box, x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
    });
    return { checked: true, issues: logo ? issues : issues.filter((i) => i.kind !== "logo_box") };
  } catch (error) {
    console.error("[ads] verifying the ad failed", error);
    return { checked: false, issues: [] };
  }
}

const FIX_SYSTEM_PROMPT = `You repair full-screen 9:16 portrait image ads. You are a retoucher: your output is image 1 with one problem fixed and nothing else changed.

Rules:
- Image 1 is the ad. Image 2, when attached, is the same ad with a dashed pink outline around the area to fix; its position is also given in words. Change only that area of image 1; everything else (framing, layout, background, lighting, people and poses, the headline and button with their wording, typeface, size and position) stays identical.
- The outline is only a guide. Return image 1 itself, edited, and never draw outlines, boxes, circles, numbers, arrows, labels or other marks.
- Leftover marks (numbered circles, pins, boxes, arrows, labels, stray digits or watermarks): remove them completely and fill each spot with what would naturally be behind it.
- Copy: where the problem is the text, set the headline and the button text exactly as given in keep_exactly (each once, spelled exactly), in the same typeface, size, color and position.
- The brand logo image, when attached, is the real logo: where the problem is a logo (the ad's own, or one printed on a product), reproduce it exactly as in that image (same mark, letterforms, colors, proportions) at the same place and a similar size, and remove any wrong logo or wordmark. The plain background its image may sit on isn't part of it: don't draw a box behind it.
- A logo in a box (a panel or patch of solid color behind it that isn't part of the design): remove the box so the logo sits directly on the ad's background, like printed artwork, and keep the logo's letterforms, colors, position and size exactly.
- Product photos or screenshots, when attached, are the real ones: where the problem is a product or screen, make it match them exactly (color, print, shape, and every part where it is and as it attaches), or remove what isn't real. Never invent a product, screen, dashboard or data.
- Return the full ad at the same 9:16 size.`;

/**
 * One repair edit for one problem: Nano Banana edits the ad, given a copy
 * with a dashed outline around the problem (no number: one problem per
 * edit, so there's less to copy), the position in words, and (for a logo,
 * product or screen) the real references. A copied outline is caught by the
 * next check as an `artifact` and removed. Images go to fal as short-lived
 * signed URLs from our bucket.
 */
export async function fixAd(input: {
  campaignId: string;
  adId: string;
  draft: FalImage;
  issue: AdIssue;
  productUrls: string[];
  /** The real logo as a URL fal can fetch, for a logo problem. */
  logoUrl?: string;
  headline: string;
  cta: string;
}): Promise<FalImage> {
  const { issue } = input;
  const bucket = supabase().storage.from(AD_BUCKET);
  const token = randomUUID();
  const draftPath = `${input.campaignId}/check-${input.adId}-${token}.png`;
  const cropPath = `${input.campaignId}/marks-check-${input.adId}-${token}.png`;
  try {
    const crop = await drawMarkers(input.draft.bytes, [{ x: issue.x, y: issue.y, box: issue.box }]);
    const [a, b] = await Promise.all([
      bucket.upload(draftPath, input.draft.bytes, { contentType: "image/png", upsert: true }),
      bucket.upload(cropPath, crop, { contentType: "image/png", upsert: true }),
    ]);
    if (a.error || b.error) throw a.error ?? b.error;
    const signed = await bucket.createSignedUrls([draftPath, cropPath], 15 * 60);
    const [draftUrl, cropUrl] = (signed.data ?? []).map((s) => s.signedUrl);
    if (!draftUrl || !cropUrl) throw new Error("couldn't sign the draft");

    // Text is fixed from the instruction alone: an image of the wrong text
    // anchors the model to it (a repeated headline word came back unchanged).
    const withCrop = issue.kind !== "copy";
    const imageUrls = withCrop ? [draftUrl, cropUrl] : [draftUrl];
    const lines = [
      "image 1: the ad to repair (return this image, edited)",
      ...(withCrop ? [`image 2: image 1 with a dashed outline around the area to fix (${describeRegion(issue.box)}; guide only)`] : []),
    ];
    // A boxed logo is fixed without the logo image: that image is on a solid
    // background, which is how the box got there.
    if (issue.kind === "logo" && input.logoUrl) lines.push(`image ${imageUrls.push(input.logoUrl)}: the brand's real logo`);
    if (issue.kind === "fake_product" || issue.kind === "fake_screen") {
      for (const url of input.productUrls.slice(0, 6)) lines.push(`image ${imageUrls.push(url)}: a real product photo or screenshot`);
    }
    const fix = {
      problem: issue.problem,
      // Text needs an exact instruction: the model rewrites the lines as given.
      fix:
        issue.kind === "copy"
          ? `The text is wrong: ${issue.problem} Change the headline so it reads exactly "${input.headline}" (delete any repeated or extra words or lines, add any missing ones), and the button so it reads exactly "${input.cta}". Keep the same typeface, weight, size, color and alignment; reflow the lines naturally.`
          : issue.fix,
      where: { what: issue.where, area_of_image_1: describeRegion(issue.box), ...(withCrop && { outlined_on: "image 2" }) },
      keep_exactly: {
        headline: input.headline,
        call_to_action: input.cta,
        everything_else: "as in image 1",
      },
    };
    const prompt = `Repair image 1. Attached images, in order:
${lines.map((l) => `- ${l}`).join("\n")}

The problem to fix (JSON):
${JSON.stringify(fix, null, 2)}

Fix only this, only in that area. Return the whole of image 1, and don't draw the outline.`;
    return await falImage({ prompt, systemPrompt: FIX_SYSTEM_PROMPT, imageUrls }, input.adId);
  } finally {
    await bucket.remove([draftPath, cropPath]).catch(() => undefined);
  }
}

const artifactSchema = z.object({
  marks: z
    .array(
      z.object({
        what: z.string().describe("What the mark is and where, e.g. 'a red circle with the number 3 next to the logo'."),
        left: fraction,
        top: fraction,
        right: fraction,
        bottom: fraction,
      }),
    )
    .max(10)
    .describe("Every leftover mark. Empty when there are none."),
});

/**
 * Leftover editing marks in an ad after an edit (numbered circles, pins,
 * boxes, arrows, labels, stray digits), as `artifact` issues ready for fixAd.
 * A cheaper, narrower check than verifyAd, for comment edits. Never throws.
 */
export async function findArtifacts(image: Uint8Array): Promise<AdIssue[]> {
  try {
    const ad = await prepare(image, 1024);
    const { output } = await generateText({
      model: VERIFY_MODEL,
      instructions:
        "You spot leftover editing marks in finished ads: numbered circles or dots, pins, dashed or solid boxes drawn around things, arrows, labels, stray digits or watermarks that aren't part of the design. The headline, the button, the logo, text printed on products and real design elements are not marks.",
      messages: [
        {
          role: "user",
          content: [
            { type: "file", data: ad, mediaType: "image/jpeg" },
            { type: "text", text: "List every leftover mark with a tight box around it." },
          ],
        },
      ],
      output: Output.object({ schema: artifactSchema }),
    });
    return output.marks.map((m) => {
      const box = { left: Math.min(m.left, m.right), top: Math.min(m.top, m.bottom), right: Math.max(m.left, m.right), bottom: Math.max(m.top, m.bottom) };
      return {
        kind: "artifact" as const,
        problem: `Leftover mark: ${m.what}.`,
        fix: "Remove the mark completely and fill the spot with what would naturally be behind it.",
        where: m.what,
        box,
        x: (box.left + box.right) / 2,
        y: (box.top + box.bottom) / 2,
      };
    });
  } catch (error) {
    console.error("[ads] looking for leftover marks failed", error);
    return [];
  }
}

/** One line on what the check found, for the chat ("a logo that didn't match the real one and a product that wasn't right"). */
export function describeIssues(issues: AdIssue[]): string {
  const kinds = [...new Set(issues.map((i) => i.kind))].map((k) =>
    k === "logo"
      ? "a logo that didn't match the real one"
      : k === "logo_box"
        ? "a box behind the logo"
        : k === "fake_product"
          ? "a product that wasn't right"
          : k === "artifact"
            ? "leftover editing marks"
            : k === "copy"
              ? "text that wasn't exactly the headline or button copy"
              : "an invented screen",
  );
  return kinds.length > 1 ? `${kinds.slice(0, -1).join(", ")} and ${kinds.at(-1)}` : (kinds[0] ?? "");
}
