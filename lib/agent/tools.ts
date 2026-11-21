import { tool, type InferUITools, type UIMessage } from "ai";
import { z } from "zod";

/**
 * The ad agent's tools, shared by the chat route (server) and the chat UI
 * (client), so tool parts in messages are typed on both sides.
 *
 * - The human-in-the-loop pauses have no `execute`: the model calls them and
 *   the run ends waiting on the user, whose answer becomes the tool output
 *   (sent by the page) and starts the next turn:
 *   - `chooseProducts`: the agent asks which products to advertise; the page
 *     switches to the Products tab in select mode.
 *   - `proposeIdeas`: about 5 creative ad ideas for those products, shown as
 *     cards in the chat; the user ticks some and presses Generate, which
 *     saves each picked idea's headline + CTA to `campaign_headlines` and
 *     sends the picks to the agent (a chat message for an older card).
 *   - `proposeHeadlines`: the old headline card. Kept only so old threads
 *     still render; the model no longer gets it (workflows/agent.ts).
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

/**
 * One creative ad idea. The card shows the title, `pitch`, copy and style;
 * `direction` is the detailed art direction for the image model. Older idea
 * cards had `concept` / `scene` / `showsOff` instead; they're optional so
 * those threads still load.
 */
export const adIdea = z.object({
  title: z.string().describe('A few words naming the idea, e.g. "Commute essential" or "Bold claim on brand blue".'),
  style: z
    .enum(["scene", "minimal"])
    .optional()
    .describe(
      'Required. "scene": a photographic moment (a setting, people, the product in use). "minimal": a clean graphic ad on a plain or soft brand-color background with a big headline, the logo, lots of space and at most one graphic element; the product may or may not appear.',
    ),
  visual: z
    .enum(["product", "product_graphic", "brand_graphic", "none"])
    .optional()
    .describe(
      'Required. The ad\'s visual: "product" shows the product itself; "product_graphic" shows the real product with the brand visuals around it (a backdrop, frame or props of the brand\'s shapes, patterns or illustrations); "brand_graphic" uses the brand visuals as the one visual element, without the product; "none" is type only. The two graphic options need brand visuals in the kit. For services, software and AI, "brand_graphic" is the preferred minimal look; for physical goods the graphic options are optional.',
    ),
  showProduct: z.boolean().optional().describe("Older ideas only; use visual."),
  pitch: z
    .string()
    .optional()
    .describe(
      "Required. 1–3 short sentences for the user: what the ad shows and why it works for this audience. This is all the card shows, so keep it tight.",
    ),
  direction: z
    .string()
    .optional()
    .describe(
      "Required. Art direction for the image model (not shown to the user): composition, background, what's in frame, how the product is shown (or that it isn't), type placement, mood and light. Specific, 2–5 sentences.",
    ),
  concept: z.string().optional().describe("Older ideas only; use pitch."),
  scene: z.string().optional().describe("Older ideas only; use direction."),
  showsOff: z.string().optional().describe("Older ideas only."),
  headline: z.string().describe("The headline, at most about 8 words, playing off the image, in the brand's voice. No emojis."),
  cta: z.string().describe('The call-to-action button text, 1–3 words, e.g. "Shop now". No emojis.'),
  productIds: z.array(z.string()).min(1).max(3).describe("Catalog ids of the chosen products this idea is about (even when the product isn't shown)."),
});
export type AdIdea = z.infer<typeof adIdea>;
/** The creative direction generateAd passes to the image model. */
export const ideaDirection = adIdea.pick({
  title: true,
  style: true,
  visual: true,
  showProduct: true,
  pitch: true,
  direction: true,
  concept: true,
  scene: true,
  showsOff: true,
});
export type IdeaDirection = z.infer<typeof ideaDirection>;

export const chooseProductsSpec = tool({
  description:
    "Ask the user which products (or services) to make ads about. The page opens the Products tab, where they tick some and confirm, or press \"Let Ploy choose\" (up to 5 hero picks, chosenBy \"ploy\"). Write your question in text too. They may answer in chat instead (typing a product or pasting a link); then the result is empty and you match what they wrote.",
  inputSchema: z.object({
    question: z.string().describe('A short question for the selection bar, e.g. "Which cases should these ads feature?"'),
  }),
  outputSchema: z.object({
    productIds: z.array(z.string()).describe("Catalog ids the user selected. Empty when they answered in chat."),
    titles: z.array(z.string()).describe("Their names, in the same order."),
    chosenBy: z
      .enum(["user", "ploy"])
      .optional()
      .describe('"ploy" when the user let you choose: the products are up to 5 hero picks across types.'),
  }),
});

export const proposeIdeasSpec = tool({
  description:
    "Show the user about 5 creative ad ideas for the chosen products as cards. They tick the ones to make and press Generate. Don't repeat the ideas in your text.",
  inputSchema: z.object({
    productIds: z.array(z.string()).min(1).max(6).describe("The chosen products these ideas are for."),
    ideas: z.array(adIdea).min(3).max(6),
  }),
  outputSchema: z.object({
    picked: z
      .array(adIdea)
      .describe("The ideas the user chose to make, each saved as a headline just now. Empty when they replied in chat instead."),
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
  /** The ad or edit was prepared and is being made by its own run; its row (by tool call) has the outcome. */
  started: z.boolean().optional(),
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
    "Generate one full-screen 9:16 portrait image ad for a saved headline and CTA (usually a picked idea's), built on real product photos with Nano Banana Pro, following the idea's creative direction when given. The brand's colors, fonts and voice are applied automatically. It returns as soon as the ad is prepared (\"Started Ad N\"); the image is then made on its own in about a minute, and the chat and Ads tab show it when ready. ok: false means it wasn't started (fix what the summary says). Call it once per idea; several calls in the same step start in parallel.",
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
    idea: ideaDirection
      .optional()
      .describe("The picked idea this ad makes: its title, style, visual, pitch and direction, as on the card. Pass it whenever the ad comes from an idea."),
    retryOf: z
      .string()
      .optional()
      .describe("When retrying a failed ad: its id (from the failed ads in your instructions). The new ad takes its place and number, and reuses its products and idea unless you pass others."),
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
    "Make a new version of an existing ad from feedback: the comments the user pinned on it (applied automatically) and/or an instruction you write from what they said in chat. Keeps the headline, CTA and products; the original stays as the earlier version. It returns as soon as the edit is prepared (\"Started the edit of Ad N\"); the new version is made on its own in about a minute, and the chat and Ads tab show it with what changed. ok: false means it wasn't started.",
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
        visuals: z
          .array(z.number().int().min(1))
          .max(3)
          .optional()
          .describe("Brand visuals to send, by their number in the brand visuals list (V1 = 1): the brand's own graphics, e.g. to add or swap in one of its shapes or illustrations."),
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
  findBrandVisuals: tool({
    description:
      "Find the brand's own graphics on its site (3D shapes, a mascot, illustrations, patterns; never customer logos, people or products) and save them to the kit as brand visuals. Nothing is generated: a site without any keeps none. For brand-graphic and product + brand-graphic ads. Needs the homepage read.",
    inputSchema: z.object({}),
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
  chooseProducts: chooseProductsSpec,
  proposeIdeas: proposeIdeasSpec,
  /** Old threads only: not offered to the model. */
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

/** The tools that pause the run until the user answers (no server `execute`). */
export const PAUSE_TOOLS = new Set(["chooseProducts", "proposeIdeas", "proposeHeadlines"]);

/** The question the agent is waiting on (a product pick, an idea card or an old headline card), if the thread is paused on one. */
export function pendingChoice(messages: AgentUIMessage[]) {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return null;
  for (const part of last.parts) {
    if (
      (part.type === "tool-chooseProducts" || part.type === "tool-proposeIdeas" || part.type === "tool-proposeHeadlines") &&
      part.state === "input-available"
    ) {
      return part;
    }
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
