# AI Ads

A take-home for Ploy: an agentic app that takes an ecommerce marketer from a store URL to 9:16 portrait image ads they would actually run. The example store is https://www.loopycases.com.

## Product loop

URL → **Research** (brand + products) → **Generate** (image ads) → **Manage** (review, iterate, approve) → feedback back into Generate. The agent does the work; the user steers.

- **Onboard:** research the brand (logo, colors, voice, value prop, audience) and pull real product images and details from the store. Decide deliberately what is scraped, what is inferred, and what is asked of the user.
- **Generate:** full-screen 9:16 portrait ads built on the store's **real product photos**, never an invented product, with the headline and CTA rendered inside the image.
- **Manage:** brand kit, campaigns, ads, variants, assets and status persist in Supabase. The user can give feedback, edit, regenerate and approve.
- **Human in the loop:** at least one point where the agent pauses for user input, and one where user feedback changes the next generation.

Working software that feels good beats breadth. Tool failures must degrade gracefully, never dead-end.

## Stack (fixed by the brief — do not swap layers)

- Next.js 16 App Router, React 19, Tailwind 4, TypeScript
- Vercel AI SDK + AI Elements for the agent and chat UI (streaming, tool calls, generative UI)
- Supabase: Postgres, Storage, optional Auth (a single demo user is fine)
- fal.ai for image generation. fal URLs are not durable: **always copy outputs into Supabase Storage** and store our URL, never fal's.
- Firecrawl or a web search API for research
- LLM via Vercel AI Gateway
- Hosted on Vercel, project `jiu-jiu-s-team/ai-ads`, connected to GitHub `jooj99/ai-ads`. Pushes to `main` deploy to production at https://ai-ads-dusky.vercel.app; PRs get preview deploys.

## Check current docs, not memory

Next.js 16, the AI SDK and AI Elements change faster than model training data. Before writing framework code, read the version-matched docs instead of relying on recall:

- Next.js: `node_modules/next/dist/docs/` (matches the installed version). Heed deprecation notices.
- `cacheComponents` and `partialPrefetching` are enabled in `next.config.ts`, so caching follows the Cache Components model (`"use cache"`, `cacheLife`, `cacheTag`), not older `fetch`/`unstable_cache` patterns.
- AI SDK, AI Elements, Supabase and fal: check their current docs or the installed packages' types before using an API.

## UI and design

- shadcn/ui on **Radix** (`components.json`, style `radix-nova`). Keep Radix: AI Elements depends on it. Add components with `npx shadcn@latest add <name>`.
- Theme tokens in `app/globals.css` mirror ploy.ai's own `--ploy-*` variables: ink `#212121` on a `#f4f4f4` canvas, white surfaces, `#e3e3e3` borders. Brand accents (`brand-yellow`, `brand-pink`, `brand-orange`) are for sparing use.
- Type: Geist for UI text and small titles (`font-sans` / `font-heading`); `font-display` (Anton, standing in for Ploy's commercial FK Screamer) only for big uppercase page headlines.
- Buttons are pills (`rounded-full`, edited in `components/ui/button.tsx`); the active sidebar tab is an ink pill.
- App shell: `app/layout.tsx` wraps every page in `SidebarProvider` → `AppSidebar` + `SidebarInset` (with `SiteHeader`). Nav items live in `lib/nav.ts`.

## Campaigns and brand research

- Home's **Start Campaign** (`app/actions.ts` server action) validates the URL, inserts a `campaigns` row and redirects to `/campaigns/[id]`, where `components/campaigns/campaign-research.tsx` starts research on arrival.
- Supabase schema: `supabase/migrations/` (`campaigns`, `brand_kits` 1:1, `campaign_products`). RLS is on with no policies; all access goes through `lib/supabase/server.ts` with the secret key, and `lib/campaigns.ts` is the only data layer.
- `POST /api/research` (`app/api/research/route.ts`) takes `{ messages, campaignId }`, streams a UI message of data parts (`data-step`, `data-brandKit`, `data-notice`) consumed with `useChat`, and saves the final kit, steps and products to the campaign when the run ends, so reloads show the saved result.
- `lib/research/pipeline.ts` runs Shopify detection (`/meta.json`) and the homepage read (Firecrawl full page incl. navbar and footer: `markdown` + `branding` + `links` + `rawHtml`) in parallel; a quick Haiku call (`lib/research/offering.ts`) classifies the business as **goods or services**; the catalog follows from that (`lib/research/catalog.ts`): goods use Shopify `/products.json` or one product page per navbar category, services use the site's service pages and their own photos (never the Shopify retail shop). Then one `streamText` + `Output.object` call (`lib/research/insights.ts`) writes value prop, audience and voice and groups the **whole** catalog into at most 10 kinds of product/service (styles and collections are not types) with 1–2 hero picks each. Picks without photos get their pages read afterwards (plain HTML first, to spare Firecrawl's ~15 req/min free limit).
- When Firecrawl's `branding` leaves gaps (no real logo, under two colors, missing or internal font names), `lib/research/html-signals.ts` reads the rendered HTML plus up to four stylesheets: logos from structured data, `<img>`, CSS `mask`/`background` images (scored by home link, aria-label and selector so header icons lose) and inline SVG; colors from CSS design tokens; readable font names from `@font-face` files. If there's still no logo, `probeLogoPaths` checks `/logo.svg`, `/assets/logo.png` and similar.
- Scraped facts (logo, colors, fonts, products, images) never pass through the model; it only returns product ids, which are matched back to the real catalog.
- Needs `FIRECRAWL_API_KEY` and AI Gateway access (OIDC via `vercel env pull`, or `AI_GATEWAY_API_KEY`). Without them each step degrades and says so instead of failing.
- Model: `anthropic/claude-sonnet-5.5` by default (needs paid Gateway credits); override with `RESEARCH_MODEL`. The local OIDC token expires after ~12h; rerun `vercel env pull .env.local` if the Gateway starts rejecting requests.

## Commands

- `npm run dev` — local dev server
- `npm run build` — production build (run before pushing)
- `npm run lint` — ESLint

## Working agreements

- The user must be able to explain every part of the system in review, so explain the mechanics of what you build and surface product decisions for the user to make rather than deciding silently.
- Do not write the key-decisions note or the architecture diagram; those are the user's own deliverables.
- Session transcripts are a deliverable: keep secrets out of the conversation. Refer to env vars by name, never print their values.
- Secrets live in `.env.local` (gitignored) locally and in Vercel project env vars for deploys.
