-- Research becomes a set of steps the agent can run one at a time, so each
-- step's inputs must be stored, not just the final brand kit, and re-running
-- a step must never overwrite what the user or agent changed.

-- What each step read, so later steps (and re-runs) build on it instead of
-- scraping again: page reads (kind 'page', key = URL), the Shopify detection
-- (kind 'shopify'), the chosen offering/index/audience links (kind 'links').
create table public.research_snapshots (
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  kind text not null check (kind in ('page', 'shopify', 'links')),
  key text not null,
  data jsonb not null,
  fetched_at timestamptz not null default now(),
  primary key (campaign_id, kind, key)
);
alter table public.research_snapshots enable row level security;
grant select, insert, update, delete on public.research_snapshots to service_role;

-- Products keep the site's own type and tags (for regrouping later) and who
-- added them: research re-runs only replace what research added.
alter table public.campaign_products
  add column listed_type text,
  add column tags text[] not null default '{}',
  add column origin text not null default 'research' check (origin in ('research', 'agent', 'user'));

-- Brand kit fields the user or agent edited (e.g. 'colors', 'audience.segments',
-- 'valueProposition', 'productTypes'); research never overwrites these.
alter table public.brand_kits add column edited text[] not null default '{}';

-- The durable agent run working on the campaign right now, if any.
alter table public.campaigns add column agent_run_id text;

notify pgrst, 'reload schema';
