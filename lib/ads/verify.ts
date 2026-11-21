import "server-only";

import { randomUUID } from "node:crypto";

import { generateText, Output } from "ai";
import sharp from "sharp";
import { z } from "zod";

import { describeRegion, drawLocationMap } from "@/lib/ads/markers";
import { falImage, type FalImage } from "@/lib/ads/render";
import { WEBP, workWebp } from "@/lib/ads/webp";
import { AD_BUCKET } from "@/lib/ads/store";
import { supabase } from "@/lib/supabase/server";
import { GATEWAY_CACHING } from "@/lib/ai-caching";
import { ModelStalledError, withStallRetry } from "@/lib/ai-retry";
import { publicFetch } from "@/lib/research/public-fetch";

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
  /** What's in the box, e.g. "the product in the person's right hand". */
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
            "logo: a logo in the ad (the ad's own logo, or one printed on a product, packaging or sign) that differs from the real logo or the product photos (shape, letterforms, colors, an added or missing wordmark), is garbled, or is missing (the ad should show the real logo). logo_box: the logo itself is right but looks pasted on: it sits in a box, panel, sticker or patch of solid color (often white or black) that isn't part of the ad's design, instead of being printed directly on the ad's background. fake_product: a product that isn't one of the reference products, or a reference product with anything changed: its color, print or pattern, shape, or a part moved, added, removed or attached differently (a grip loop, strap, handle, button, cutout or badge in a different place or form), or shown using a part it doesn't have (a strap it lacks, a loop where there is none), or held, worn, attached or used in a way its photos or notes don't show it working. Only the setting, people, pose and props around it are free. fake_screen: a screen, dashboard, app interface, chart or data that isn't one of the reference screenshots. artifact: a leftover editing mark that isn't part of the design: a numbered circle or dot, a pin, a box drawn around something, an arrow, a label, stray digits or a watermark. copy: the headline or call-to-action isn't exactly the given text (a repeated, missing, extra or misspelled word, or it appears twice).",
          ),
        problem: z.string().describe("What's wrong, in one short sentence."),
        fix: z
          .string()
          .describe(
            "An instruction for an image editor that fixes it inside the box, e.g. 'Recolor the product to the cream of the reference with its printed pattern' or 'Replace the logo with the real logo from the reference, same position and size'.",
          ),
        where: z.string().describe("What's in the box and where, in a few words, e.g. 'the product in the person's right hand, center of the ad'."),
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

/** `ours`: a signed URL from our own bucket (local Supabase in dev); anything else is a page's image. */
async function download(url: string, ours = false): Promise<Uint8Array | null> {
  try {
    const init = { signal: AbortSignal.timeout(10_000) };
    const res = await (ours ? fetch(url, init) : publicFetch(url, init));
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
  /** The brand's own graphics were sent for the ad: abstract shapes, patterns and illustrations around the product are intended. */
  graphics?: boolean;
  /** The exact copy the ad must show, when known. */
  headline?: string;
  cta?: string;
  /** The link the brief asked for, anywhere on the ad ("loopycases.com"). */
  link?: string;
  /** How each product works (its parts, use and what it never has), one line per product. */
  productNotes?: string[];
};

/** The problems a vision model finds in the draft. Never throws: on failure it reports none (and logs). */
/**
 * The check's result. `stalled`: the model never answered (every attempt
 * timed out), so the ad goes out unchecked and the studio says so.
 */
export type VerifyResult = { checked: boolean; issues: AdIssue[]; stalled?: boolean };

export async function verifyAd(input: VerifyInput): Promise<VerifyResult> {
  try {
    const [ad, logo, products] = await Promise.all([
      prepare(input.image, 1024),
      input.logoUrl ? download(input.logoUrl, true).then((b) => (b ? prepare(b, 512, true) : null)) : Promise.resolve(null),
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
            : `Products: everything the brand sells that appears must be one of the references, unchanged.${
                input.graphics
                  ? " The ad also uses the brand's own graphics (abstract 3D shapes, patterns or illustrations) around the product on purpose: those are not products, so don't report them unless one is made to look like a product."
                  : ""
              }`
        } Compare each product in the ad with its reference photos part by part: base color, print or pattern and its colors, shape and proportions, and every part: where it sits, its size and how it attaches, plus cutouts.${
                input.productNotes?.length
                  ? ` How the products really work (facts read from their photos):\n${input.productNotes.map((n) => `- ${n}`).join("\n")}\nA part drawn differently from these notes, anything their "Never" lists, or a use that contradicts their "Use" (held, worn, attached or used in a way the product can't be) is a fake_product problem.`
                  : ""
              } Also compare how the product is used with the reference photos: a part placed somewhere else on the product, attached differently, hanging loose when it's fixed in the photos (or fixed when it hangs), or held or used in a way the photos don't show is a fake_product problem. Only the setting, people, pose and props are free. Each difference is its own fake_product problem; a product that's right except one moved part is still wrong.${
          input.services
            ? " This brand sells a service: any screen, dashboard or interface must be one of the reference screenshots; an invented one is a problem."
            : " An invented screen or dashboard is a problem too."
        } ${
          input.headline
            ? `Copy: the headline must read exactly "${input.headline}" and the button exactly "${input.cta ?? ""}"${
                input.link ? `, and the link "${input.link}" must appear somewhere (inside the button, near it or elsewhere; anywhere is fine)` : ""
              }, each once; a repeated, missing, extra or misspelled word${input.link ? " or a misspelled or missing link" : ""} is a copy problem (box the text). `
            : ""
        }Also report every leftover editing mark (numbered circles or dots, pins, drawn boxes, arrows, labels, stray digits, watermarks) as an artifact, each with its own box. Otherwise ignore the background, people, props, lighting, colors, the headline, the button and the layout. For each problem give the tight box around the object that's wrong and say what's in it.`,
      },
    ];
    const { output } = await withStallRetry("the ad check", (abortSignal) => generateText({
      model: VERIFY_MODEL,
      providerOptions: GATEWAY_CACHING,
      abortSignal,
      maxRetries: 0,
      instructions:
        "You are a strict brand-safety checker for ads made by an image model. You compare the ad with the brand's real logo and real product references and report only real problems: a logo that isn't the real one or looks pasted on, a fake or altered product, or an invented screen. Look at products closely: image models often keep a product's general look but recolor it, or move, reshape or reinvent one of its parts; those are real problems. A new setting, people, pose or props are intended, not a problem; but the product itself must look and be used the way its photos show (a part moved to a different place, attached differently, or hanging or used in a way the photos don't show is a real problem). Locate each problem precisely. Don't report style choices, and don't report something you can't see clearly.",
      messages: [{ role: "user", content }],
      output: Output.object({ schema: issueSchema }),
    }));
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
    return { checked: false, issues: [], stalled: error instanceof ModelStalledError };
  }
}

const FIX_SYSTEM_PROMPT = `You repair full-screen 9:16 portrait image ads. You are a retoucher: your output is image 1 with the listed problems fixed and nothing else changed.

Rules:
- Image 1 is the ad. Image 2, when attached, is a location map, not part of the ad: a black image the same size as image 1 with a numbered white area over each place to fix (numbered like the problems; each position is also given in words). Lay it over image 1 in your mind to find each place. Fix each problem only inside its area; everything outside them (framing, layout, background, lighting, people and poses, the headline and button with their wording, typeface, size and position) stays identical.
- Nothing from the location map goes into the ad: never draw white or black areas, boxes, outlines, circles, pins, numbers, arrows, labels or any other marks. Return image 1 itself, edited.
- Leftover marks (numbered circles, pins, boxes, arrows, labels, stray digits or watermarks): remove them completely and fill each spot with what would naturally be behind it.
- Copy: where the problem is the text, set the headline and the button text exactly as given in keep_exactly (each once, spelled exactly), in the same typeface, size, color and position.
- The brand logo image, when attached, is the real logo: where the problem is a logo (the ad's own, or one printed on a product), reproduce it exactly as in that image (same mark, letterforms, colors, proportions) at the same place and a similar size, and remove any wrong logo or wordmark. The plain background its image may sit on isn't part of it: don't draw a box behind it.
- A logo in a box (a panel or patch of solid color behind it that isn't part of the design): remove the box so the logo sits directly on the ad's background, like printed artwork, and keep the logo's letterforms, colors, position and size exactly.
- Product photos or screenshots, when attached, are the real ones, and product_facts (when given) say how each product really works: where the problem is a product or screen, make it match them exactly (color, print, shape, every part where it is and as it attaches, and its use), or remove what isn't real. Never invent a product, screen, dashboard or data.
- Return the full ad at the same 9:16 size.`;

/** Problems fixed in one repair edit (the rest wait for the next round). */
export const MAX_FIXES_PER_EDIT = 6;

/**
 * One repair edit for several problems at once, the way a comment edit
 * works: Nano Banana edits the ad, given a copy with a numbered dashed box
 * around each problem, each position in words, and (for a logo, product or
 * screen problem) the real references and the products' notes. A box or
 * number it copies into the result is caught by the next check as an
 * `artifact`; the flow never keeps a version with one (lib/ads/flow.ts).
 * Images go to fal as short-lived signed URLs from our bucket.
 */
export async function fixAd(input: {
  campaignId: string;
  adId: string;
  draft: FalImage;
  issues: AdIssue[];
  productUrls: string[];
  /** The real logo as a URL fal can fetch, for a logo problem. */
  logoUrl?: string;
  headline: string;
  cta: string;
  link?: string;
  /** How each product works, for product problems. */
  productNotes?: string[];
}): Promise<FalImage> {
  const issues = input.issues.slice(0, MAX_FIXES_PER_EDIT).map((issue, i) => ({ ...issue, n: i + 1 }));
  if (!issues.length) throw new Error("nothing to fix");
  // Text is fixed from the instruction alone: an image of the wrong text
  // anchors the model to it (a repeated headline word came back unchanged).
  // So copy problems get no box; the others are boxed and numbered.
  const boxed = issues.filter((i) => i.kind !== "copy");
  const bucket = supabase().storage.from(AD_BUCKET);
  const token = randomUUID();
  // WebP, not PNG: fal downloads both, about 1 MB each instead of 6–7 MB.
  const draftPath = `${input.campaignId}/check-${input.adId}-${token}.webp`;
  const marksPath = `${input.campaignId}/marks-check-${input.adId}-${token}.webp`;
  try {
    const [draft, marks] = await Promise.all([
      workWebp(input.draft.bytes),
      boxed.length
        ? drawLocationMap(input.draft.bytes, boxed.map((i) => ({ n: i.n, x: i.x, y: i.y, box: i.box })))
        : Promise.resolve(null),
    ]);
    const uploads = await Promise.all([
      bucket.upload(draftPath, draft, { contentType: WEBP, upsert: true }),
      ...(marks ? [bucket.upload(marksPath, marks, { contentType: WEBP, upsert: true })] : []),
    ]);
    const failed = uploads.find((u) => u.error);
    if (failed) throw failed.error;
    const paths = marks ? [draftPath, marksPath] : [draftPath];
    const signed = await bucket.createSignedUrls(paths, 15 * 60);
    const urls = (signed.data ?? []).map((s) => s.signedUrl).filter((u): u is string => Boolean(u));
    if (urls.length !== paths.length) throw new Error("couldn't sign the draft");

    const imageUrls = [...urls];
    const lines = [
      "image 1: the ad to repair (return this image, edited)",
      ...(marks ? ["image 2: a location map, not part of the ad: black, with a numbered white area over each place to fix"] : []),
    ];
    // A boxed logo is fixed without the logo image: that image is on a solid
    // background, which is how the box got there.
    if (issues.some((i) => i.kind === "logo") && input.logoUrl) {
      lines.push(`image ${imageUrls.push(input.logoUrl)}: the brand's real logo`);
    }
    const productIssue = issues.some((i) => i.kind === "fake_product" || i.kind === "fake_screen");
    if (productIssue) {
      for (const url of input.productUrls.slice(0, 6)) lines.push(`image ${imageUrls.push(url)}: a real product photo or screenshot`);
    }
    const copyFix = `Change the headline so it reads exactly "${input.headline}" (delete any repeated or extra words or lines, add any missing ones), and the button so it reads exactly "${input.cta}"${
      input.link ? `, and the link reads exactly "${input.link}", once (keep it where it is; if it's missing, add it where it fits the design, such as inside or under the button)` : ""
    }. Keep the same typeface, weight, size, color and alignment; reflow the lines naturally.`;
    const fixes = {
      fixes: issues.map((i) => ({
        n: i.n,
        problem: i.problem,
        // Text needs an exact instruction: the model rewrites the lines as given.
        fix: i.kind === "copy" ? `The text is wrong: ${i.problem} ${copyFix}` : i.fix,
        where: {
          what: i.where,
          area_of_image_1: describeRegion(i.box),
          ...(i.kind !== "copy" && marks && { on_the_map: `white area ${i.n}` }),
        },
      })),
      ...(productIssue && input.productNotes?.length && { product_facts: input.productNotes }),
      keep_exactly: {
        headline: input.headline,
        call_to_action: input.cta,
        ...(input.link && { link: input.link }),
        everything_else: "as in image 1, outside those areas",
      },
    };
    const prompt = `Repair image 1. Attached images, in order:
${lines.map((l) => `- ${l}`).join("\n")}

The problems to fix (JSON):
${JSON.stringify(fixes, null, 2)}

Fix each one, only in its area. Return the whole of image 1, with nothing from the location map drawn in it.`;
    return await falImage({ prompt, systemPrompt: FIX_SYSTEM_PROMPT, imageUrls }, input.adId);
  } finally {
    await bucket.remove([draftPath, marksPath]).catch(() => undefined);
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
    const { output } = await withStallRetry("the leftover-mark check", (abortSignal) => generateText({
      model: VERIFY_MODEL,
      providerOptions: GATEWAY_CACHING,
      abortSignal,
      maxRetries: 0,
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
    }));
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
