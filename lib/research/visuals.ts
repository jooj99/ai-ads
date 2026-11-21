import "server-only";

import { generateText, Output } from "ai";
import sharp from "sharp";
import { z } from "zod";

import { fetchHtml, imagesFromHtml } from "./html-signals";
import type { BrandVisual, CatalogItem } from "./types";
import { absoluteUrl, isPublicHttpUrl } from "./url";
import { GATEWAY_CACHING } from "@/lib/ai-caching";
import { withStallRetry } from "@/lib/ai-retry";

/**
 * The brand's own graphics: 3D shapes, a mascot, illustrations, patterns,
 * the visual language of its site. Minimal ads can use them as their one
 * visual instead of the product (Ploy's glassy jelly shapes, say).
 *
 * Research collects candidate images (the homepage's share image and
 * images, the share images of hero pages, catalog photos), and a vision
 * model sorts every one: brand graphic, product photo, lifestyle photo,
 * person, another company's logo (testimonial and "trusted by" sections are
 * full of them), the brand's own logo, screenshot, other. Only brand graphics
 * are kept, strongest first, each with a short description the agent can
 * write ideas around. File names are never trusted; the picture decides.
 */

export const VISUALS_MODEL =
  process.env.VISUALS_MODEL ?? process.env.AGENT_MODEL ?? process.env.RESEARCH_MODEL ?? "anthropic/claude-sonnet-5.5";

const MAX_CANDIDATES = 24;
const MAX_VISUALS = 6;
const MAX_PAGE_READS = 8;
const UA = "Mozilla/5.0 (compatible; PloyAds/1.0)";

const schema = z.object({
  images: z.array(
    z.object({
      index: z.number().int().describe("The image's number."),
      kind: z
        .enum([
          "brand_graphic",
          "product_photo",
          "lifestyle_photo",
          "person",
          "other_company_logo",
          "own_logo",
          "screenshot",
          "other",
        ])
        .describe(
          "brand_graphic: the brand's own art: 3D shapes or objects, a mascot or character, illustrations, patterns or abstract graphics in its visual style (a share image or banner whose main subject is such art counts, even with some text). product_photo: a photo of something the brand sells. lifestyle_photo: a scene or setting. person: a portrait or headshot. other_company_logo: another company's logo or mark (customers, partners, press). own_logo: the brand's own logo or favicon. screenshot: an app or website screen. other: anything else (icons, stock, decoration).",
        ),
      description: z.string().describe("What it shows, in a few words, e.g. 'glassy pastel jelly-like 3D shapes'."),
      strength: z.number().int().min(1).max(5).describe("For brand graphics: how distinctive and ad-worthy (5 = unmistakably this brand, clean, striking)."),
    }),
  ),
});

/** A candidate image and where it was found (context for the classifier). */
export type VisualCandidate = { url: string; source: string };

/** Candidate images from the site, best sources first. Never throws. */
export async function visualCandidates(
  siteUrl: string,
  shareImage: string | undefined,
  catalog: CatalogItem[],
): Promise<VisualCandidate[]> {
  const found: VisualCandidate[] = [];
  const push = (u: string | null | undefined, source: string) => {
    if (u && isPublicHttpUrl(u) && !found.some((c) => c.url === u)) found.push({ url: u, source });
  };
  push(shareImage, "the homepage's share image");
  // The homepage's own images (hero art usually comes first).
  try {
    const { html, base } = await fetchHtml(new URL(siteUrl));
    push(absoluteUrl(ogImage(html), base), "the homepage's share image");
    for (const src of imagesFromHtml(html, base).slice(0, 14)) push(src, "an image on the homepage");
  } catch {}
  // Hero pages' share images: where many brands put their art.
  const heroes = catalog.filter((p) => p.isHero).slice(0, MAX_PAGE_READS);
  const shares = await Promise.all(
    heroes.map(async (p) => {
      try {
        const { html, base } = await fetchHtml(new URL(p.url));
        return absoluteUrl(ogImage(html), base);
      } catch {
        return undefined;
      }
    }),
  );
  shares.forEach((u, i) => push(u, `the share image of the "${heroes[i].title}" page`));
  for (const p of [...heroes, ...catalog.filter((p) => !p.isHero)]) {
    for (const src of p.images.slice(0, 1)) push(src, `an image on the "${p.title}" page`);
  }
  return found
    .filter((c) => !/\.(svg|ico|gif)(\?|$)/i.test(c.url))
    .map((c) => ({ ...c, url: largeVersion(c.url) }))
    .filter((c, i, all) => all.findIndex((x) => x.url === c.url) === i)
    .slice(0, MAX_CANDIDATES);
}

/**
 * The image at a usable size: image CDNs (Next.js, Shopify, imgix,
 * Cloudinary-style query params) serve whatever width the page asked for,
 * often a small thumbnail (Anthropic's illustrations came as ?w=192). A
 * small requested width becomes 1600; everything else is unchanged.
 */
export function largeVersion(url: string): string {
  try {
    const u = new URL(url);
    let changed = false;
    for (const key of ["w", "width"]) {
      const v = Number(u.searchParams.get(key));
      if (v && v < 1200) {
        u.searchParams.set(key, "1600");
        changed = true;
      }
    }
    // Width and height together would distort; drop a small fixed height.
    for (const key of ["h", "height"]) {
      const v = Number(u.searchParams.get(key));
      if (changed && v && v < 1200) u.searchParams.delete(key);
    }
    return changed ? u.href : url;
  } catch {
    return url;
  }
}

/** The brand graphics among the candidates, strongest first. Never throws: [] on failure. */
export async function classifyVisuals(brand: string, candidates: VisualCandidate[]): Promise<BrandVisual[]> {
  const loaded = (
    await Promise.all(
      candidates.map(async ({ url, source }) => {
        try {
          const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(10_000) });
          if (!res.ok) return null;
          const img = sharp(Buffer.from(await res.arrayBuffer()));
          const meta = await img.metadata();
          if ((meta.width ?? 0) < 160 || (meta.height ?? 0) < 120) return null; // icons and thumbnails
          const data = await img
            .resize(320, 320, { fit: "inside" })
            .flatten({ background: "#ffffff" })
            .jpeg({ quality: 80 })
            .toBuffer();
          return { url, source, data };
        } catch {
          return null;
        }
      }),
    )
  ).filter((x) => x !== null);
  if (!loaded.length) return [];
  try {
    const { output } = await withStallRetry("sorting the site's images", (abortSignal) => generateText({
      model: VISUALS_MODEL,
      providerOptions: GATEWAY_CACHING,
      abortSignal,
      maxRetries: 0,
      instructions: `You sort images from ${brand}'s website for an ad team. Decide what each one is, using the picture and its context (where it was found, its file name). Be strict about brand graphics: only ${brand}'s own art (3D shapes, a mascot, illustrations, patterns), never another company's logo, a product photo, a person or a screenshot. Product and feature pages often show customers' and partners' logos ("trusted by", testimonials): a mark named after another company, or one that looks like a standalone logo, is other_company_logo even when it's stylized or 3D.`,
      messages: [
        {
          role: "user",
          content: [
            ...loaded.flatMap((img, i) => [
              {
                type: "text" as const,
                text: `Image ${i + 1} (${img.source}; file "${img.url.split("?")[0].split("/").pop()}"):`,
              },
              { type: "file" as const, data: img.data, mediaType: "image/jpeg" },
            ]),
            { type: "text" as const, text: `Classify every image (1–${loaded.length}).` },
          ],
        },
      ],
      output: Output.object({ schema }),
    }));
    return output.images
      .filter((i) => i.kind === "brand_graphic" && loaded[i.index - 1])
      .sort((a, b) => b.strength - a.strength)
      .slice(0, MAX_VISUALS)
      .map((i) => ({ url: loaded[i.index - 1].url, description: i.description }));
  } catch (error) {
    console.error("[research] classifying brand visuals failed", error);
    return [];
  }
}

function ogImage(html: string): string | undefined {
  const tag = html.match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]*>/i)?.[0];
  return tag?.match(/content=["']([^"']+)["']/i)?.[1];
}

