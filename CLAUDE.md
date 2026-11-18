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

## Commands

- `npm run dev` — local dev server
- `npm run build` — production build (run before pushing)
- `npm run lint` — ESLint

## Working agreements

- The user must be able to explain every part of the system in review, so explain the mechanics of what you build and surface product decisions for the user to make rather than deciding silently.
- Do not write the key-decisions note or the architecture diagram; those are the user's own deliverables.
- Session transcripts are a deliverable: keep secrets out of the conversation. Refer to env vars by name, never print their values.
- Secrets live in `.env.local` (gitignored) locally and in Vercel project env vars for deploys.
