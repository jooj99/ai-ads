import { generateText, Output } from "ai";
import { z } from "zod";

import type { LayoutLink } from "./html-signals";
import { OFFERING_MODEL } from "./offering";
import type { Offering } from "./types";

/**
 * Link picker: one small-model call sorts the site's own links into the pages
 * worth reading. Keyword lists can't do this: a B2B navbar says "Platform",
 * "Records" or "Intelligence", not "products" or "services".
 *
 * The model sees labels and paths only (no page reads) and returns link
 * numbers, which are matched back to the real URLs, so it can't invent pages.
 */

export type LinkKind = "offering" | "index" | "audience";

export type PickedLink = {
  url: string;
  /** The link's own label; empty for links found only in the page body. */
  text: string;
  /** The menu heading or product line the model placed it under, if any. */
  group?: string;
};

export type LinkPicks = {
  /** Pages about one thing the business sells: a product, module, plan or service. */
  offerings: PickedLink[];
  /** Pages listing several offerings: "Solutions", "All services", a shop category. */
  indexes: PickedLink[];
  /** Pages about who the business serves: industries, customer types, roles. */
  audience: PickedLink[];
};

/** A link offered to the model; `area` says where on the homepage it was found. */
export type CandidateLink = { url: string; text: string; area: LayoutLink["area"] | "page" };

const pickSchema = z.object({
  links: z
    .array(
      z.object({
        n: z.number().int().describe("The link's number in the list."),
        kind: z
          .enum(["offering", "index", "audience"])
          .describe(
            "offering: a page about ONE thing the business sells (a product, product line, software module, plan or service). index: a page listing several offerings (e.g. 'Solutions', 'All services', 'Pricing' with several plans, a shop category like 'Sunglasses'). audience: a page about who they serve rather than what they sell (industries, customer types, roles).",
          ),
        group: z
          .string()
          .describe(
            "For offerings, the menu heading or product line it sits under as the site names it (e.g. 'Platform'); empty string if none.",
          ),
      }),
    )
    .describe(
      "Only links that are offerings, indexes or audience pages. Leave out everything else: home, about, team, careers, blog, news, docs, support, contact, demo or booking pages, legal, login.",
    ),
});

export async function classifyLinks({
  domain,
  offering,
  navigation,
  candidates,
}: {
  domain: string;
  offering: Offering;
  /** The navbar's labels in order, so the model can see how menus group links. */
  navigation: string;
  candidates: CandidateLink[];
}): Promise<LinkPicks> {
  const list = candidates
    .map((c, i) => `${i + 1}. [${c.area}] ${c.text || "(no label)"} → ${pathOf(c.url)}`)
    .join("\n");

  const { output } = await generateText({
    model: OFFERING_MODEL,
    instructions: `You sort a website's links so an ad tool reads the pages that describe what the business sells.
This business sells ${offering}. Judge each link by its label, its path and where it sits (nav, footer or page body).
A software company's products are often named modules ("Records", "Dispatch", "Intelligence"); those are offerings.
Features of the site itself (compliance, security, integrations, migration) are not offerings unless the link is to a page selling them.
Sales and promotions (Black Friday, Cyber Monday, holiday deals, "Sale", clearance, "New arrivals", "Best sellers", gift guides) are not offerings or indexes: they cut across what the business sells. Prefer the permanent pages for each kind of product or service.`,
    prompt: [`Website: ${domain}`, navigation && `Navbar labels in order: ${navigation}`, "", "Links:", list]
      .filter((line): line is string => typeof line === "string")
      .join("\n"),
    output: Output.object({ schema: pickSchema }),
  });

  const picks: LinkPicks = { offerings: [], indexes: [], audience: [] };
  const used = new Set<string>();
  for (const pick of output.links) {
    const candidate = candidates[pick.n - 1];
    if (!candidate || used.has(candidate.url)) continue; // only real, unrepeated links
    used.add(candidate.url);
    const link: PickedLink = {
      url: candidate.url,
      text: candidate.text,
      group: pick.group.trim() || undefined,
    };
    if (pick.kind === "offering") picks.offerings.push(link);
    else if (pick.kind === "index") picks.indexes.push(link);
    else picks.audience.push(link);
  }
  return picks;
}

function pathOf(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}
