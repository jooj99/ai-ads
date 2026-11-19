import { generateText, Output } from "ai";
import { z } from "zod";

import type { PageResearch } from "./page";

/** Small, fast model for one classification; override with OFFERING_MODEL. */
export const OFFERING_MODEL = process.env.OFFERING_MODEL ?? "anthropic/claude-haiku-5.5";

const offeringSchema = z.object({
  offering: z
    .enum(["goods", "services"])
    .describe(
      "goods: the business mainly sells physical or digital products customers buy and receive. services: it mainly sells work done for the customer (appointments, treatments, classes, memberships, repairs, consulting, agencies, subscriptions to a service).",
    ),
  reason: z.string().describe("One short sentence citing what on the site decided it."),
});

export type OfferingResult = z.infer<typeof offeringSchema>;

/**
 * Decides whether research should build a product catalog or a service
 * catalog. Runs on the homepage read (title, navbar, footer, opening copy);
 * a Shopify store is strong but not conclusive evidence of goods.
 */
export async function classifyOffering({
  domain,
  page,
  isShopify,
  guidance,
}: {
  domain: string;
  page: PageResearch | null;
  isShopify: boolean;
  /** Direction from the agent or user, e.g. "they sell treatments, not retail". */
  guidance?: string;
}): Promise<OfferingResult> {
  const prompt = [
    `Website: ${domain}${isShopify ? " (runs on Shopify, an ecommerce platform)" : ""}`,
    page?.title && `Title: ${page.title}`,
    page?.description && `Description: ${page.description}`,
    page?.navigation && `Navbar: ${page.navigation}`,
    page?.footer && `Footer: ${page.footer.slice(0, 1_500)}`,
    page?.content && `Homepage (start):\n${page.content.slice(0, 5_000)}`,
    guidance?.trim() && `Direction from the marketer (follow it where the content supports it): ${guidance.trim()}`,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n\n");

  const { output } = await generateText({
    model: OFFERING_MODEL,
    instructions:
      "Classify what this business sells so an ad tool knows whether to feature products or services. When it sells both, choose what the homepage leads with.",
    prompt,
    output: Output.object({ schema: offeringSchema }),
  });
  return output;
}
