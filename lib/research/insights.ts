import { Output, streamText } from "ai";
import { z } from "zod";

import type { PageResearch } from "./page";
import { MAX_PRODUCT_TYPES, type Offering, type Product } from "./types";

/**
 * Brand-analysis model, routed through Vercel AI Gateway (needs paid Gateway
 * credits; the free tier only allows OpenAI's GPT-5 models). Override with
 * RESEARCH_MODEL, e.g. "openai/gpt-5", to compare.
 */
export const RESEARCH_MODEL = process.env.RESEARCH_MODEL ?? "anthropic/claude-sonnet-5.5";

/** Up to this size the model lists every item's type by id; above it, by listed type values. */
export const SMALL_CATALOG = 60;

/** The brand half of research: who the brand is and how it sounds. */
export const brandInsightsSchema = z.object({
  brandName: z
    .string()
    .describe("The brand's name as customers know it, without legal marks or taglines."),
  tagline: z
    .string()
    .describe("A short brand tagline, at most 8 words. Reuse the site's own tagline if it has one."),
  valueProposition: z
    .string()
    .describe(
      "The central value proposition of what the business sells, in one or two sentences: what the customer gets and why it beats alternatives. Be specific to this brand, cite concrete proof (guarantees, review counts, materials, credentials) when the site gives it.",
    ),
  audience: z.object({
    summary: z
      .string()
      .describe(
        "Who buys from this brand and what they care about, in one or two sentences. Not shown to the user; it briefs the ad agent.",
      ),
    segments: z
      .array(z.string())
      .describe(
        "3 to 6 audience tags shown to the user, each 1 to 4 words in sentence case, e.g. 'Busy parents', 'Gen Z gifters'. Distinct groups, no overlap.",
      ),
  }),
  voice: z.object({
    summary: z
      .string()
      .describe("How the brand sounds, in one or two sentences an ad writer could follow."),
    traits: z.array(z.string()).describe("3 to 5 one- or two-word tone traits, e.g. 'Playful'."),
    sampleLine: z
      .string()
      .describe("One example ad headline written in this voice, at most 10 words."),
  }),
});

/** The catalog half: the catalog's kinds of product and the heroes to feature. */
export const catalogGroupingSchema = z.object({
  productTypes: z
    .array(
      z.object({
        name: z
          .string()
          .describe(
            "Short name for a KIND of product or service, e.g. 'Prescription glasses', 'Sunglasses', 'Phone cases', 'Facials'.",
          ),
        summary: z.string().describe("One line on what this type covers."),
        catalogTypes: z
          .array(z.string())
          .describe(
            "The catalog's own listed type values (from the 'types across all' summary) that belong to this type, copied exactly. Empty if items have no listed type.",
          ),
        memberIds: z
          .array(z.string())
          .describe(
            `Only when the catalog lists ${SMALL_CATALOG} items or fewer: the ids of ALL items of this type. Otherwise an empty array.`,
          ),
        items: z
          .array(
            z.object({
              id: z.string().describe("The item id exactly as listed in the catalog."),
              reason: z
                .string()
                .describe("One short sentence on why this item is a strong ad candidate."),
              features: z
                .array(z.string())
                .describe(
                  "3 to 5 concrete features or benefits from the item's listing, each under 8 words.",
                ),
            }),
          )
          .describe(
            "1 or 2 hero items of this type: best sellers or homepage features. Prefer items with photos and, when a type has varied styles, visually different ones; if no item of the type has photos, still list its best item.",
          ),
      }),
    )
    .describe(
      `Group the WHOLE catalog into its distinct kinds of product (what the item IS or does), at most ${MAX_PRODUCT_TYPES}, ordered by advertising potential (flagship kind first). Styles, prints, colors, materials, collections, collaborations, seasons and sizes are NOT types: "floral cases" and "holiday cases" are both just "Phone cases". Cover the whole catalog: every item should fit one of the types, whether or not it has photos. Use only as many types as the catalog really has; fewer than ${MAX_PRODUCT_TYPES} is normal. Use only ids from the catalog.`,
    ),
});

export type BrandInsights = z.infer<typeof brandInsightsSchema>;
export type CatalogGrouping = z.infer<typeof catalogGroupingSchema>;

const NOUNS: Record<Offering, { item: string; items: string; catalog: string }> = {
  goods: { item: "product", items: "products", catalog: "Product catalog" },
  services: { item: "service", items: "services", catalog: "Service catalog" },
};

const MAX_CONTENT_CHARS = 20_000;
const MAX_CATALOG_CHARS = 60_000;
/** The brand call sees a sample of the catalog, enough to judge range and price. */
const BRAND_CATALOG_CHARS = 8_000;

type InsightsInput = {
  domain: string;
  page: PageResearch | null;
  products: Product[];
  offering: Offering;
  /** Labels of the site's pages about who it serves, e.g. "Hospitals", "For agencies". */
  audiencePages?: string[];
  /** Direction from the agent or user, e.g. "group cases by phone model". Followed when it fits the facts. */
  guidance?: string;
};

/**
 * Streams the brand insights: name, tagline, value proposition, audience and
 * voice. The caller reads `partialOutputStream`, then `output`.
 */
export function streamBrandInsights(input: InsightsInput) {
  const n = NOUNS[input.offering];
  return streamText({
    model: RESEARCH_MODEL,
    instructions: `You are a brand strategist preparing a brand kit for performance ad creatives.
This business sells ${input.offering}. Read its homepage, navbar, footer and a sample of its ${n.item} catalog, then describe the brand: its name, tagline, value proposition, audience and voice.
Ground every claim in the provided content; when you infer (audience, voice), infer from the copy, ${n.items} and prices.`,
    prompt: promptFor(input, { contentChars: MAX_CONTENT_CHARS, catalogChars: BRAND_CATALOG_CHARS }),
    output: Output.object({ schema: brandInsightsSchema }),
    // Stream errors don't throw; without this the cause (e.g. a Gateway
    // billing or rate-limit error) is lost behind NoOutputGeneratedError.
    onError: ({ error }) => console.error("[research] brand insights stream error", error),
  });
}

/**
 * Streams the catalog grouping: at most 10 kinds of product or service, each
 * with its members and 1–2 hero picks. Only ids from the catalog count; the
 * caller matches them back to the real items.
 */
export function streamCatalogGrouping(input: InsightsInput) {
  const n = NOUNS[input.offering];
  return streamText({
    model: RESEARCH_MODEL,
    instructions: `You are a brand strategist choosing what to advertise.
This business sells ${input.offering}. Organize its whole ${n.item} catalog into kinds of ${n.item} and pick the ${n.items} to feature in ads.
Use the navbar and footer as the brand's own category list.
Never invent ${n.items}: ids must come from the catalog exactly.`,
    prompt: promptFor(input, { contentChars: 5_000, catalogChars: MAX_CATALOG_CHARS }),
    output: Output.object({ schema: catalogGroupingSchema }),
    onError: ({ error }) => console.error("[research] catalog grouping stream error", error),
  });
}

function promptFor(
  { domain, page, products, offering, audiencePages = [], guidance }: InsightsInput,
  { contentChars, catalogChars }: { contentChars: number; catalogChars: number },
): string {
  const n = NOUNS[offering];
  return [
    `Website: ${domain}`,
    page?.title && `Page title: ${page.title}`,
    page?.description && `Meta description: ${page.description}`,
    page?.siteName && `Site name: ${page.siteName}`,
    page?.styleHints && `Style analysis of the rendered site: ${page.styleHints}`,
    "",
    ...(guidance?.trim()
      ? [
          "## Direction from the marketer (follow it where the content supports it; never invent facts or ids for it)",
          guidance.trim(),
          "",
        ]
      : []),
    "## Navbar",
    page?.navigation || "(none found)",
    "",
    "## Footer",
    page?.footer || "(none found)",
    "",
    ...(audiencePages.length
      ? [
          "## Who the site says it serves (its industry and customer pages; use for audience, these are not offerings)",
          audiencePages.join(" · "),
          "",
        ]
      : []),
    "## Homepage content",
    page?.content ? page.content.slice(0, contentChars) : "(The homepage could not be read.)",
    "",
    `## ${n.catalog}: types across all ${products.length} ${n.items}`,
    typeSummary(products) || "(No types listed.)",
    "",
    `## ${n.catalog} (id | title | type | price | tags | photos | description)`,
    catalogForPrompt(products, catalogChars) || `(No ${n.items} were found.)`,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

/**
 * Counts per listed type over the WHOLE catalog, so types are grouped from the
 * full range even when the line-by-line list below gets truncated.
 */
function typeSummary(products: Product[]): string {
  const counts = new Map<string, number>();
  for (const p of products) {
    const type = p.productType?.trim() || "(untyped)";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 60)
    .map(([type, count]) => `${type}: ${count}`)
    .join("; ");
}

function catalogForPrompt(products: Product[], maxChars: number): string {
  let out = "";
  for (const p of products) {
    const line = [
      p.id,
      p.title,
      p.productType ?? "",
      p.price ?? "",
      (p.tags ?? []).slice(0, 6).join(", "),
      `${p.images.length} photos`,
      (p.description ?? "").slice(0, 180),
    ].join(" | ");
    if (out.length + line.length > maxChars) break;
    out += line + "\n";
  }
  return out.trim();
}
