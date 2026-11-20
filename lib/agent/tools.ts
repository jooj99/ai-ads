import { tool, type InferUITools, type UIMessage } from "ai";
import { z } from "zod";

/**
 * The ad agent's tools, shared by the chat route (server) and the chat UI
 * (client), so tool parts in messages are typed on both sides.
 *
 * - `proposeHeadlines` has no `execute`: it's the human-in-the-loop pause.
 *   The model calls it and the UI renders the options as a choice card.
 *   Ticking options (or writing your own) is a local selection until the
 *   user presses Submit, which saves it to `campaign_headlines` and sends it
 *   to the agent: as this tool's output when the agent is waiting on the
 *   card, or as a chat message for an older card. Cards stay usable after
 *   the conversation moves on.
 * - `saveHeadline` / `removeHeadline` run on the server (the route adds
 *   `execute`), for when the user asks for changes in chat.
 * - `generateAd` makes one 9:16 ad on fal (server-side, `lib/ads/generate.ts`);
 *   `editAd` makes a new version of one from pinned comments (`lib/ads/edit.ts`).
 * - `editBrandText`, `editTags`, `editColors`, `editFonts` let the agent change
 *   the brand kit when asked (server-side, `lib/agent/kit-tools.ts`). Each
 *   returns a one-line summary the chat shows.
 */

export const headlineOption = z.object({
  headline: z
    .string()
    .describe("The ad headline, at most about 6 words / 40 characters, in the brand's voice."),
  cta: z.string().describe('The call-to-action button text, 1–3 words, e.g. "Shop now".'),
  angle: z
    .string()
    .describe('A few words on the angle this option takes, e.g. "Product-led" or "Audience benefit".'),
});

export type HeadlineOption = z.infer<typeof headlineOption>;
export type CampaignCopy = { headline: string; cta: string };

const copy = z.object({ headline: z.string(), cta: z.string() });

export const proposeHeadlinesSpec = tool({
  description:
    "Show the user 3 headline + CTA options for the campaign's ads as a choice card. They can save any number of them or write their own, then continue. Don't repeat the options in your text.",
  inputSchema: z.object({
    question: z
      .string()
      .describe('A short question above the options, e.g. "Which headlines should the first ads use?"'),
    options: z.array(headlineOption).min(2).max(4),
  }),
  outputSchema: z.object({
    /**
     * The headlines the user saved from this card (picked or written). Empty
     * when they replied in chat instead. Threads saved before multi-select
     * stored one pick or null; those are read as a list.
     */
    picked: z
      .preprocess(
        (value) => (value == null ? [] : Array.isArray(value) ? value : [value]),
        z.array(copy),
      )
      .describe(
        "The headlines the user chose on this card. They were saved just now because the user picked them: new picks, never duplicates of earlier ones.",
      ),
    /** Previously saved headlines the user unticked on this card before submitting. */
    removed: z.array(copy).optional(),
  }),
});

export const saveHeadlineSpec = tool({
  description:
    "Save a headline + CTA to the campaign when the user writes one in chat or asks to keep a variation. Use their exact wording.",
  inputSchema: z.object({
    headline: z.string().min(1).max(80),
    cta: z.string().min(1).max(30),
  }),
  outputSchema: z.object({ saved: z.boolean() }),
});

export const removeHeadlineSpec = tool({
  description: "Remove one of the campaign's saved headlines when the user asks to drop it.",
  inputSchema: z.object({ headline: z.string(), cta: z.string() }),
  outputSchema: z.object({ removed: z.boolean() }),
});

const kitEditResult = z.object({ ok: z.boolean(), summary: z.string() });

export const editBrandTextSpec = tool({
  description:
    "Rewrite one text field of the brand kit when the user asks: the tagline, value proposition, audience description, voice description, or the sample line in the brand's voice. Write the full new text.",
  inputSchema: z.object({
    field: z.enum(["tagline", "valueProposition", "audienceDescription", "voiceDescription", "voiceSampleLine"]),
    text: z.string().min(1).max(600),
  }),
  outputSchema: kitEditResult,
});

export const editTagsSpec = tool({
  description:
    "Add or remove tags in the brand kit: audience segments (who the brand sells to, 1–4 words each) or voice traits (one or two words, e.g. 'Playful'). Only touch what the user asked for.",
  inputSchema: z.object({
    list: z.enum(["audience", "voiceTraits"]),
    add: z.array(z.string().min(1).max(40)).max(8).optional(),
    remove: z.array(z.string()).max(12).optional().describe("Existing tags to remove, as written."),
  }),
  outputSchema: kitEditResult,
});

export const editColorsSpec = tool({
  description:
    "Add or remove brand colors when the user asks. Colors are 6-digit hex codes with a short role (Primary, Accent, Background, Text…).",
  inputSchema: z.object({
    add: z
      .array(z.object({ hex: z.string().regex(/^#[0-9a-fA-F]{6}$/), role: z.string().min(1).max(40) }))
      .max(6)
      .optional(),
    remove: z.array(z.string()).max(12).optional().describe("Hex codes of colors to remove."),
  }),
  outputSchema: kitEditResult,
});

export const editFontsSpec = tool({
  description:
    "Add or remove brand fonts when the user asks. Use real font family names (ideally on Google Fonts so they preview) with a role (Headings, Body…).",
  inputSchema: z.object({
    add: z
      .array(z.object({ family: z.string().min(1).max(80), role: z.string().min(1).max(40) }))
      .max(4)
      .optional(),
    remove: z.array(z.string()).max(8).optional().describe("Family names of fonts to remove."),
  }),
  outputSchema: kitEditResult,
});

// --- ads ---------------------------------------------------------------------

const adResult = z.object({
  ok: z.boolean(),
  summary: z.string(),
  ad: z.object({ id: z.string(), url: z.string(), headline: z.string(), cta: z.string() }).optional(),
  /** For edits: what visibly changed, from comparing the ad before and after. */
  changes: z.array(z.string()).optional(),
});

/** Images the user attached in chat, to use in an ad (by their ref), each with how to use it. */
const references = z
  .array(
    z.object({
      image: z.string().describe('The image\'s ref from the chat, e.g. "3f2a….png".'),
      use: z
        .string()
        .max(300)
        .describe('How the image model should use it, e.g. "add this sticker to the phone case" or "match this background style".'),
    }),
  )
  .max(4)
  .optional()
  .describe("Images the user attached in chat that they want used in this ad. Only ones they asked to use.");

export const generateAdSpec = tool({
  description:
    "Generate one full-screen 9:16 portrait image ad for a saved headline and CTA, built on real product photos with Nano Banana Pro. It takes about a minute. The brand's colors, fonts and voice are applied automatically. Call it once per headline; several calls in the same step run in parallel.",
  inputSchema: z.object({
    headline: z.string().min(1).max(80).describe("A saved headline, exactly as saved."),
    cta: z.string().min(1).max(30).describe("Its CTA, exactly as saved."),
    productIds: z
      .array(z.string())
      .min(1)
      .max(3)
      .optional()
      .describe("Catalog ids (from the catalog in your instructions, getCatalog or addProductFromLink) of 1–2 products whose photos suit this headline; the item the user asked for when they named one or linked to it. Defaults to the first hero."),
    references,
  }),
  outputSchema: adResult,
});

export const deleteAdSpec = tool({
  description:
    "Delete an ad when the user asks: one version of it, or the whole ad with every version. Use the id of the version they mean (from the ads list). Can't be undone.",
  inputSchema: z.object({
    adId: z.string().describe("The id of the ad version (from the ads list in your instructions)."),
    scope: z.enum(["version", "ad"]).describe('"version" deletes just that version; "ad" deletes the ad and all its versions.'),
  }),
  outputSchema: z.object({ ok: z.boolean(), summary: z.string() }),
});

export const editAdSpec = tool({
  description:
    "Make a new version of an existing ad from feedback: the comments the user pinned on it (applied automatically) and/or an instruction you write from what they said in chat. Keeps the headline, CTA and products. Takes about a minute; the original stays as the earlier version.",
  inputSchema: z.object({
    adId: z.string().describe("The id of the ad version to edit (from the ads list in your instructions)."),
    instruction: z
      .string()
      .max(500)
      .optional()
      .describe("A change the user asked for in chat, written as a clear edit request. Omit when only applying pinned comments."),
    references,
    include: z
      .object({
        logo: z.boolean().optional().describe("Send the real brand logo as an image (e.g. to fix, add or swap in the logo)."),
        colors: z
          .union([z.literal("all"), z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/))])
          .optional()
          .describe('Brand colors to send, as hex codes from the kit (or "all"): each goes as text and as a solid swatch image.'),
        productIds: z
          .array(z.string())
          .max(3)
          .optional()
          .describe("Catalog ids of products whose photos to send (e.g. to swap or fix a product)."),
        fonts: z.boolean().optional().describe("Send the brand font names."),
        voice: z.boolean().optional().describe("Send the brand voice (traits and description)."),
      })
      .optional()
      .describe(
        "Brand kit items to send with this edit. By default an edit sees only the ad, so it keeps everything else; include only what the change needs.",
      ),
  }),
  outputSchema: adResult,
});

// --- research --------------------------------------------------------------

/** Every research tool returns this: a summary for the chat and small data for the agent. */
const researchResult = z.object({
  ok: z.boolean(),
  summary: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});

const guidance = z
  .string()
  .max(500)
  .optional()
  .describe("The user's direction for this step, restated briefly, e.g. 'group cases by phone model'.");
const force = z
  .boolean()
  .optional()
  .describe("Overwrite fields the user or agent edited. Only when the user explicitly asks to reset their edits.");

export const readSkillSpec = tool({
  description: "Read a skill (a playbook) by name before doing that kind of work, e.g. 'research'.",
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.object({ ok: z.boolean(), body: z.string() }),
});

export const researchToolSpecs = {
  researchStatus: tool({
    description: "What research has done and what's missing, item by item, plus which fields are edited.",
    inputSchema: z.object({}),
    outputSchema: researchResult,
  }),
  getCatalog: tool({
    description:
      "A compact list of catalog items (id, title, listed type, assigned type, hero, price, photo count), filtered by type or search text. Use it to find the item the user means: query with their words for it ('lavender case', 'brow lamination'), best match first, or with its page link.",
    inputSchema: z.object({
      typeName: z.string().optional(),
      query: z.string().optional().describe("Words describing the item (matched loosely against title, type, tags and description), or its page URL."),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    outputSchema: researchResult,
  }),
  detectPlatform: tool({
    description: "Check whether the site is a Shopify store (whose whole catalog can then be loaded).",
    inputSchema: z.object({}),
    outputSchema: researchResult,
  }),
  readSite: tool({
    description:
      "Read a page of the site (the homepage by default) and store it for later steps. On the homepage it applies the logo, colors, fonts and name it finds; on other pages only the `fields` you pass. Returns the page's title and navigation (and an excerpt for non-home pages).",
    inputSchema: z.object({
      url: z.string().url().optional().describe("A page on the brand's own site; omit for the homepage."),
      fields: z.array(z.enum(["name", "logo", "colors", "fonts"])).optional(),
      force,
    }),
    outputSchema: researchResult,
  }),
  classifyOffering: tool({
    description: "Decide (with a small model) whether the business sells goods or services. Needs the homepage read.",
    inputSchema: z.object({ guidance }),
    outputSchema: researchResult,
  }),
  setOffering: tool({
    description: "Set goods or services directly when it's obvious or the user said so.",
    inputSchema: z.object({ offering: z.enum(["goods", "services"]), reason: z.string().max(200) }),
    outputSchema: researchResult,
  }),
  listSiteLinks: tool({
    description: "The homepage's own links (navbar, footer, body), to choose pages to read yourself.",
    inputSchema: z.object({}),
    outputSchema: researchResult,
  }),
  findOfferingPages: tool({
    description: "Pick (with a small model) which homepage links are product or service pages, index pages and audience pages.",
    inputSchema: z.object({ guidance }),
    outputSchema: researchResult,
  }),
  loadCatalog: tool({
    description:
      "Load products or services into the catalog: from the Shopify catalog, or by reading the site's pages (the picked ones, or `urls`). 'replace' swaps out what research found before; 'add' keeps it. Items the user or agent added always stay.",
    inputSchema: z.object({
      from: z.enum(["shopify", "pages"]),
      urls: z.array(z.string().url()).max(12).optional(),
      mode: z.enum(["add", "replace"]).optional(),
    }),
    outputSchema: researchResult,
  }),
  addProductFromLink: tool({
    description:
      "Add the product or service on one page the user linked to (a product page on the brand's site, or a listing elsewhere), with that page's own photos, so you can make an ad about it. Returns its catalog id (pass it to generateAd's productIds). If the link is already in the catalog it returns that item instead.",
    inputSchema: z.object({ url: z.string().url().describe("The product page link, exactly as the user gave it.") }),
    outputSchema: researchResult,
  }),
  removeProducts: tool({
    description: "Remove items from the catalog by id.",
    inputSchema: z.object({ ids: z.array(z.string()).min(1).max(100) }),
    outputSchema: researchResult,
  }),
  writeBrandInsights: tool({
    description: "Write the brand's name, tagline, value proposition, audience and voice from the stored site content (edited fields are kept unless forced).",
    inputSchema: z.object({ guidance, force }),
    outputSchema: researchResult,
  }),
  groupCatalog: tool({
    description: "Group the whole catalog into at most 10 kinds of product or service with 1–2 hero picks each, following optional direction.",
    inputSchema: z.object({ guidance, force }),
    outputSchema: researchResult,
  }),
  setProductTypes: tool({
    description:
      "Set the grouping yourself, by catalog id: every type to keep (types left out are dropped), each with its heroes and optionally members. Items you don't list as members keep their current type if it's still in the list, otherwise they become 'Other'; so to change only heroes, list the current types with their new heroIds and no memberIds.",
    inputSchema: z.object({
      types: z
        .array(
          z.object({
            name: z.string().min(1).max(60),
            summary: z.string().max(200).optional(),
            memberIds: z.array(z.string()).optional(),
            heroIds: z.array(z.string()).max(3),
          }),
        )
        .min(1)
        .max(10),
    }),
    outputSchema: researchResult,
  }),
  findPhotos: tool({
    description: "Read the pages of heroes (or the given items) that have no photo yet, to find the site's own photos.",
    inputSchema: z.object({ productIds: z.array(z.string()).max(4).optional() }),
    outputSchema: researchResult,
  }),
};

export type ResearchToolName = keyof typeof researchToolSpecs;

export const agentToolSpecs = {
  proposeHeadlines: proposeHeadlinesSpec,
  saveHeadline: saveHeadlineSpec,
  removeHeadline: removeHeadlineSpec,
  editBrandText: editBrandTextSpec,
  editTags: editTagsSpec,
  editColors: editColorsSpec,
  editFonts: editFontsSpec,
  readSkill: readSkillSpec,
  generateAd: generateAdSpec,
  editAd: editAdSpec,
  deleteAd: deleteAdSpec,
  ...researchToolSpecs,
};

/** The tools that change the brand kit or catalog; after one runs, the page re-reads them. */
export const KIT_TOOL_PARTS = new Set([
  "tool-editBrandText",
  "tool-editTags",
  "tool-editColors",
  "tool-editFonts",
  ...Object.keys(researchToolSpecs).map((name) => `tool-${name}`),
]);

/** Research tool part types, for rendering them as research steps in the chat. */
export const RESEARCH_TOOL_PARTS = new Set(Object.keys(researchToolSpecs).map((name) => `tool-${name}`));

export type AgentUIMessage = UIMessage<never, never, InferUITools<typeof agentToolSpecs>>;

/** The headline question the agent is waiting on, if the thread is paused on one. */
export function pendingChoice(messages: AgentUIMessage[]) {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return null;
  for (const part of last.parts) {
    if (part.type === "tool-proposeHeadlines" && part.state === "input-available") return part;
  }
  return null;
}

/** Same headline and CTA, ignoring case and surrounding spaces. */
export function sameCopy(a: CampaignCopy, b: CampaignCopy) {
  const norm = (s: string) => s.trim().toLowerCase();
  return norm(a.headline) === norm(b.headline) && norm(a.cta) === norm(b.cta);
}

/** The first message of every thread: what the user asked for by starting a campaign. */
export function kickoffText(domain: string) {
  return `Make ads for ${domain}`;
}
