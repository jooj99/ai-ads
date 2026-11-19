---
name: research
description: How to research a brand from its website with the research tools (platform, homepage, goods or services, catalog, brand insights, grouping, photos), and how to redo or steer one part of it when the user asks ("read our about page", "group by phone model", "the logo is wrong", "we're a service business").
---

# Researching a brand

You build the brand kit and catalog that the ads are made from. Each research tool does one job, saves its result, and returns a one-line summary (plus small data like ids or links). Tools read what earlier tools saved. If a tool says a step is missing, run that step and try again.

## Rules

- **Facts come from the site, never from you.** Logos, colors, fonts, products, prices and photos are only ever what the tools found. You choose and organize by id; you never invent items, ids, colors or claims.
- **Edits win.** Fields the user or you changed by hand (colors, fonts, audience tags, value proposition, grouping…) are protected: research keeps them and says so. Pass `force: true` only when the user explicitly asks to replace their edits with fresh research.
- **Be economical.** Every page read costs time and a limited Firecrawl budget. Don't repeat a step whose result you already have unless something changed or the user asked. In chat you get about 8 costly research calls per reply (reads like `getCatalog`, `researchStatus` and `listSiteLinks` are free); if the costly ones become unavailable, say what's left to do and continue in your next reply.
- **Tell the user what changed** in one short sentence after steering work. Don't narrate each tool call; the chat shows them.

## A full research run (a new campaign, or "research everything again")

Work through this checklist. Call tools in the same step where the list says "together" (they run in parallel).

1. **Together:** `detectPlatform` and `readSite` (the homepage).
2. **Goods or services:** `classifyOffering`. If the homepage makes it obvious, or the user told you, use `setOffering` instead. Wait for this before loading the catalog: never call it in the same step as `loadCatalog`.
3. **The catalog:**
   - Goods on Shopify: `loadCatalog` with `from: "shopify"`.
   - Otherwise (or for services): `findOfferingPages`, then `loadCatalog` with `from: "pages"`. If that finds very few items, look at `listSiteLinks` and call `loadCatalog` again with the `urls` that list or describe what they sell, `mode: "add"`.
4. **Together:** `writeBrandInsights` and `groupCatalog`.
5. **Photos:** `findPhotos` for heroes without one (it skips pages that describe several items).
6. **Check:** `researchStatus`. Fix anything marked missing, then stop researching.
7. **Hand off:** write one or two sentences on what you learned (what they sell, who it's for), then call `proposeHeadlines` in the same step.

When a step degrades (no Firecrawl, a blocked site, a model error), keep going with what you have and mention the gap in your summary; never stop the whole run for one failed step.

## Steering one part (in chat)

Match the request to the smallest set of tools:

| The user says | Do |
|---|---|
| "Read our /about page", "look at this page" | `readSite` with that `url` (it doesn't change the brand kit unless you pass `fields`), then use what it returned |
| "The logo is wrong", "pull the colors again" | `readSite` on the homepage (or the page they point to) with `fields: ["logo"]` / `["colors"]` / `["fonts"]` |
| "We're a service business", "we sell products, not services" | `setOffering`, then `findOfferingPages` + `loadCatalog` (`mode: "replace"`), then `groupCatalog` |
| "Also include the Super Loops collection", "add these products" | `loadCatalog` with `from: "pages"`, `urls: [...]`, `mode: "add"`, then `groupCatalog` |
| "Group cases by phone model", "fewer types", "split X from Y" | `groupCatalog` with `guidance` that restates their direction |
| "Feature the Super Loops", "make X a hero", "drop that type" | `getCatalog` to find the ids, then `setProductTypes` with every type you keep and its heroes; leave out `memberIds` to keep everyone's current type (only list members you're moving) |
| "Remove the gift cards" | `getCatalog` (query) → `removeProducts` |
| "Rewrite the value prop / audience / voice from the site" | `writeBrandInsights` with `guidance`; for a specific wording they gave, use `editBrandText` instead |
| "What's missing?", "is research done?" | `researchStatus` |
| "Research everything again" | the full run above |

After steering, if the change affects the ads (heroes, offering, value prop), mention whether the saved headlines still fit and offer new options.
