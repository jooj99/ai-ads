import { Output, streamText } from "ai";
import { z } from "zod";

import type { PageResearch } from "./page";
import type { Product } from "./types";

/**
 * Brand-analysis model, routed through Vercel AI Gateway (needs paid Gateway
 * credits; the free tier only allows OpenAI's GPT-5 models). Override with
 * RESEARCH_MODEL, e.g. "openai/gpt-5", to compare.
 */
export const RESEARCH_MODEL = process.env.RESEARCH_MODEL ?? "anthropic/claude-sonnet-5.5";

export const insightsSchema = z.object({
  brandName: z
    .string()
    .describe("The brand's name as customers know it, without legal marks or taglines."),
  tagline: z
    .string()
    .describe("A short brand tagline, at most 8 words. Reuse the site's own tagline if it has one."),
  valueProposition: z
    .string()
    .describe(
      "The central value proposition of the products in one or two sentences: what the customer gets and why it beats alternatives. Be specific to this brand, cite concrete proof (guarantees, review counts, materials) when the site gives it.",
    ),
  audience: z.object({
    summary: z.string().describe("Who buys these products and what they care about, in one or two sentences."),
    segments: z.array(z.string()).describe("2 to 4 short audience segments, e.g. 'Busy parents'."),
  }),
  voice: z.object({
    summary: z.string().describe("How the brand sounds, in one or two sentences an ad writer could follow."),
    traits: z.array(z.string()).describe("3 to 5 one- or two-word tone traits, e.g. 'Playful'."),
    sampleLine: z.string().describe("One example ad headline written in this voice, at most 10 words."),
  }),
  products: z
    .array(
      z.object({
        id: z.string().describe("The product id exactly as listed in the catalog."),
        reason: z.string().describe("One short sentence on why this product is a strong ad candidate."),
        features: z
          .array(z.string())
          .describe("3 to 5 concrete features or benefits from the product's listing, each under 8 words."),
      }),
    )
    .describe(
      "3 to 6 products to feature in ads: hero or best-selling products first (featured on the homepage, flagship lines), visually distinct from each other, with good photography. Use only ids from the catalog.",
    ),
});

export type Insights = z.infer<typeof insightsSchema>;

const INSTRUCTIONS = `You are a brand strategist preparing a brand kit for performance ad creatives.
Read the store's homepage and product catalog, then describe the brand and pick the products to advertise.
Ground every claim in the provided content; when you infer (audience, voice), infer from the copy, products and prices.
Never invent products: product ids must come from the catalog exactly.`;

const MAX_CONTENT_CHARS = 24_000;
const MAX_CATALOG_CHARS = 60_000;

/** Streams brand insights; the caller reads `partialOutputStream` then `output`. */
export function streamInsights({
  domain,
  page,
  products,
}: {
  domain: string;
  page: PageResearch | null;
  products: Product[];
}) {
  const catalog = catalogForPrompt(products);

  const prompt = [
    `Store: ${domain}`,
    page?.title && `Page title: ${page.title}`,
    page?.description && `Meta description: ${page.description}`,
    page?.siteName && `Site name: ${page.siteName}`,
    page?.styleHints && `Style analysis of the rendered site: ${page.styleHints}`,
    "",
    "## Homepage content",
    page?.content ? page.content.slice(0, MAX_CONTENT_CHARS) : "(The homepage could not be read.)",
    "",
    `## Product catalog (${products.length} products; id | title | type | price | tags | photos | description)`,
    catalog || "(No products were found.)",
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");

  return streamText({
    model: RESEARCH_MODEL,
    instructions: INSTRUCTIONS,
    prompt,
    output: Output.object({ schema: insightsSchema }),
    // Stream errors don't throw; without this the cause (e.g. a Gateway
    // billing or rate-limit error) is lost behind NoOutputGeneratedError.
    onError: ({ error }) => console.error("[research] insights stream error", error),
  });
}

function catalogForPrompt(products: Product[]): string {
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
    if (out.length + line.length > MAX_CATALOG_CHARS) break;
    out += line + "\n";
  }
  return out.trim();
}
