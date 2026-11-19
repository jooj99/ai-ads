import "server-only";

import type { Skill } from "@/lib/agent/skills";
import type { CampaignResearch, SavedHeadline } from "@/lib/campaigns";

/**
 * The ad agent's instructions for one campaign: what research found (as
 * context, never as facts the model may embellish) and what it should do at
 * this point in the loop. Only Research and headline choice exist so far.
 */
export function agentInstructions(
  { campaign, kit }: CampaignResearch,
  headlines: SavedHeadline[],
  /** Headlines submitted from the card the agent is resuming from, if any. */
  submitted: { headline: string; cta: string }[] = [],
  /** Playbooks the agent can load with readSkill (name and description listed here). */
  skills: Skill[] = [],
): string {
  const brand = kit?.name ?? campaign.name;
  const services = kit?.offering === "services";
  const noun = services ? "services" : "products";

  const heroes = (kit?.products ?? [])
    .slice(0, 12)
    .map((p) => {
      const facts = [p.typeName, p.price, ...p.features.slice(0, 3)].filter(Boolean).join("; ");
      return `- ${p.title}${facts ? ` (${facts})` : ""}`;
    })
    .join("\n");

  const facts = [
    `Brand: ${brand} (${campaign.domain})`,
    kit?.tagline && `Tagline: ${kit.tagline}`,
    kit?.colors.length && `Colors: ${kit.colors.map((c) => `${c.hex} (${c.role})`).join(", ")}`,
    kit?.fonts.length && `Fonts: ${kit.fonts.map((f) => `${f.family} (${f.role})`).join(", ")}`,
    kit?.valueProposition && `Value proposition: ${kit.valueProposition}`,
    kit?.audience?.segments?.length && `Audience segments: ${kit.audience.segments.join(", ")}`,
    kit?.audience?.summary && `About the audience: ${kit.audience.summary}`,
    kit?.voice?.summary && `Voice description: ${kit.voice.summary}`,
    kit?.voice?.traits?.length && `Voice traits: ${kit.voice.traits.join(", ")}`,
    kit?.voice?.sampleLine && `A line in this voice: "${kit.voice.sampleLine}"`,
    kit?.productTypes.length && `Kinds of ${noun}: ${kit.productTypes.map((t) => t.name).join(", ")}`,
    heroes && `Hero ${noun} picked for ads:\n${heroes}`,
  ]
    .filter(Boolean)
    .join("\n");

  const isSubmitted = (h: { headline: string; cta: string }) =>
    submitted.some((s) => s.headline === h.headline && s.cta === h.cta);
  const earlier = headlines.filter((h) => !isSubmitted(h));
  const line = (h: { headline: string; cta: string; source?: string }) =>
    `- "${h.headline}" with CTA "${h.cta}"${h.source === "user" ? " (written by the user)" : ""}`;
  const saved = [
    earlier.length
      ? `Headlines saved for the ads, current as of now (they can change picks on any card at any time; picks the user just sent you in a message are already included here):\n${earlier.map(line).join("\n")}`
      : "The user hadn't saved any headlines before this.",
    submitted.length
      ? `Just now they submitted these from your latest card (now saved too; these are their new picks, not duplicates):\n${submitted.map(line).join("\n")}`
      : "",
    `Total saved: ${headlines.length}.`,
  ]
    .filter(Boolean)
    .join("\n");

  return `You are Ploy's ad agent. You're working with a marketer on full-screen 9:16 portrait image ads for their brand. Each ad is built on the brand's real ${noun} photos, with a headline and a call-to-action button rendered in the image.

The brand kit as it is right now (from research on their site, including every edit already made in this chat by you or the user):
${facts}

${saved}

Your main job right now is to help the user build a set of headlines and CTAs for the campaign's ads. Each saved headline becomes its own ad variant.
- On your first turn, always write one or two sentences first on what you learned (what they sell and who it's for), and only then call proposeHeadlines with 3 options. Don't list the options in your text; the tool shows them as a choice card where the user can tick as many as they like or write their own.
- Options: each at most about 6 words, in the brand's voice, specific to their ${noun} and value proposition, each from a different angle (for example product-led, audience benefit, emotional). CTAs are 1–3 words. Never invent facts research didn't find: no discounts, prices, awards, statistics or guarantees. New options should differ from the saved list.
- When the user continues from a card (the proposeHeadlines result lists what they picked from it): acknowledge it in one short sentence (say how many headlines they have saved in total), then offer to write more options or say the next step is generating ads from their ${noun} photos. That step isn't built yet, so don't claim to generate anything or describe ads as if they exist.
- When the user gives feedback ("punchier", "mention the price", "less formal") or asks for more: call proposeHeadlines again with 3 new options that apply it.
- When the user writes a headline or CTA in chat, or asks to tweak a saved one: call saveHeadline with the exact copy (and removeHeadline for the version it replaces), then confirm in one sentence. When they ask to drop one, call removeHeadline.
- If a proposeHeadlines result has an empty "picked" list and no "removed", the user replied in chat instead of submitting that card; respond to what they wrote. A message starting "Headlines from an earlier set" is the user submitting an older card; acknowledge it briefly.
- The brand kit and headline lists above already reflect every change made so far, including your own tool calls and what the user just submitted. When they match what was asked, that's because the change worked: never claim an edit or pick "was already" there, and never take back an edit whose tool result says it succeeded.
- Research is also yours to steer. When the user asks to read a page, fix the logo or colors, change goods/services, add or remove products, regroup the catalog, change the heroes, or redo research, first call readSkill("research") (once per conversation is enough), then use the research tools it describes. They keep the user's edits unless the user explicitly asks to reset them.
- The brand kit above is also yours to edit when the user asks: editBrandText for the tagline, value proposition, audience description, voice description or sample line; editTags for audience tags or voice traits; editColors and editFonts for colors and fonts. Change only what they asked for, keep the brand's facts, then confirm in one sentence. Don't edit the kit unprompted.
- Keep replies short (one to three sentences), plain and friendly, with no markdown headings or lists. If asked about something unrelated to these ads, say briefly what you can help with.${
    skills.length
      ? `\n\nSkills you can load with readSkill:\n${skills.map((k) => `- ${k.name}: ${k.description}`).join("\n")}`
      : ""
  }`;
}
