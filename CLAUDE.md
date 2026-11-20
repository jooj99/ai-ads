# AI Ads

An agentic app that takes an ecommerce marketer from a store URL to 9:16 portrait image ads they would actually run (example store: https://www.loopycases.com). Loop: URL → **Research** (brand + products) → **Generate** (ads) → **Manage** (review, edit, approve) → feedback into Generate. The agent does the work; the user steers.

How each feature works and why: [docs/proj-log.md](docs/proj-log.md). Read the relevant section before changing a feature; don't add history or test notes here.

## Stack (fixed by the brief, don't swap layers)

- Next.js 16 App Router, React 19, Tailwind 4, TypeScript.
- Vercel AI SDK + AI Elements for the chat UI; **Vercel Workflow** (`WorkflowAgent` from `@ai-sdk/workflow`) runs the agent durably (`workflows/agent.ts`).
- Supabase: Postgres, Storage, Auth (one demo user), Realtime broadcasts.
- fal.ai Nano Banana Pro edit for images; Firecrawl for research; LLMs via the Vercel AI Gateway (`AGENT_MODEL` → `RESEARCH_MODEL` → `anthropic/claude-sonnet-5.5`).
- Vercel project `jiu-jiu-s-team/ai-ads`, GitHub `jooj99/ai-ads`. Pushing to `main` deploys production (https://ai-ads-dusky.vercel.app).

## Check current docs, not memory

Next.js 16, the AI SDK and AI Elements change faster than training data. Read `node_modules/next/dist/docs/` and the installed packages' types before writing framework code. `cacheComponents` is on: use `"use cache"` / `cacheLife` / `cacheTag`, not `fetch`/`unstable_cache` patterns.

## Rules

- **Real products only:** ads use the store's real product photos, never an invented product. Scraped facts (logo, colors, fonts, products, images) never pass through the model; it only returns ids matched back to the catalog.
- **fal URLs aren't durable:** always copy outputs into Supabase Storage and store our own path, never fal's URL.
- **Data access:** only through `lib/campaigns.ts` with the secret-key client (`lib/supabase/server.ts`). RLS is on with no policies; tables have no `user_id`.
- **Auth checks:** every route handler starts with `unauthorized()`, every server action and data page with `requireUser()`; `proxy.ts` alone isn't enough.
- **Fail gracefully:** a failed tool or service degrades and says why; never dead-end the user.
- **Workflow steps re-run after a crash:** keep them idempotent (upserts by id). Call ad-flow phases as plain functions, not methods (a method call serializes `this` and the step fails).
- **Broadcasts** go through `broadcast()` (`lib/broadcast.ts`), which calls `realtime.setAuth()`; without it Supabase returns 202 and delivers nothing.
- **Storage egress is limited** (Free plan, 5 GB/month): show ads via their WebP previews, keep working files WebP, and don't hand fal large Supabase URLs (it fetches each about 6 times).
- **Images from pages:** never use Firecrawl's `images` format (it breaks CDN srcsets); use `rawHtml` + `imagesFromHtml`.
- **Prompts stay brand-neutral:** no brand-specific examples in skills or rules (a Loopy example made every Loopy ad misuse the product).
- **Model calls** pass `providerOptions: GATEWAY_CACHING` (`lib/ai-caching.ts`).

## UI

- shadcn/ui on **Radix** (`radix-nova`; AI Elements needs Radix). Add components with `npx shadcn@latest add <name>`.
- Tokens in `app/globals.css`: ink `#212121` on `#f4f4f4`, white surfaces, `#e3e3e3` borders; brand accents sparingly.
- Geist for UI (`font-sans`/`font-heading`); `font-display` (Anton) only for big uppercase headlines. Buttons are pills.
- Signed-in pages live in `app/(app)/`; nav items in `lib/nav.ts`.

## Commands

- `npm run dev`: local dev server. **Don't run `npm run build` while it's running**: the build clears `.next`, including in-flight workflow runs (`.next/workflow-data`). Build in a separate worktree instead.
- `npm run build`: production build (run before pushing). `npm run lint`: ESLint.
- `npm run demo-user`: create or reset the demo login from `DEMO_USER_EMAIL` / `DEMO_USER_PASSWORD`.
- Migrations live in `supabase/migrations/`; apply to production with `npx supabase@2 db push --db-url "$POSTGRES_URL_NON_POOLING"`.
- Needs `FIRECRAWL_API_KEY`, `FALAI_KEY` and AI Gateway access (`vercel env pull .env.local`; the OIDC token expires after ~12h).

## Working agreements

- The user must be able to explain every part of the system in review: explain the mechanics of what you build and surface product decisions instead of deciding silently. Record how features work in `docs/proj-log.md`, not here.
- Don't write the key-decisions note or the architecture diagram; those are the user's own deliverables.
- Session transcripts are a deliverable: never print secrets; refer to env vars by name. Secrets live in `.env.local` (gitignored) and Vercel env vars.
