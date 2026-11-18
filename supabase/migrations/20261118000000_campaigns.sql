-- Campaigns and their brand research.
--
-- A campaign starts from a store URL. Research produces one brand kit per
-- campaign (identity, voice, audience, value prop) and the hero products or
-- services the ads will be built around. Ads, variants and assets will hang
-- off campaign_products in later migrations.
--
-- The app reads and writes through the server with the secret key, so RLS is
-- enabled with no policies: nothing is reachable with the public key.

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  source_url text not null,
  domain text not null,
  status text not null default 'researching'
    check (status in ('researching', 'research_failed', 'ready')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index campaigns_created_at_idx on public.campaigns (created_at desc);

-- One brand kit per campaign. Scraped facts and model inferences are kept as
-- columns where the app queries them and as jsonb where they're read whole.
create table public.brand_kits (
  campaign_id uuid primary key references public.campaigns (id) on delete cascade,
  name text,
  tagline text,
  platform text check (platform in ('shopify', 'website')),
  offering text check (offering in ('goods', 'services')),
  offering_reason text,
  logo_url text,
  logo_candidates text[] not null default '{}',
  colors jsonb not null default '[]',          -- [{ hex, role }]
  fonts jsonb not null default '[]',           -- [{ family, role }]
  value_proposition text,
  audience jsonb,                              -- { summary, segments[] }
  voice jsonb,                                 -- { summary, traits[], sampleLine }
  product_types jsonb not null default '[]',   -- [{ name, summary }], at most 10
  catalog_size integer,
  products_picked_by text check (products_picked_by in ('ai', 'default')),
  research_steps jsonb not null default '[]',  -- last run's step log, shown on reload
  research_notice jsonb,                       -- { level, message } when partly failed
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The hero products (or services) research picked, with the site's own photos.
create table public.campaign_products (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  position integer not null,
  source_id text not null,         -- Shopify product id, or the item's URL
  title text not null,
  url text not null,
  price text,
  type_name text,
  description text,
  reason text,
  features text[] not null default '{}',
  images text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (campaign_id, position)
);

create index campaign_products_campaign_id_idx on public.campaign_products (campaign_id);

alter table public.campaigns enable row level security;
alter table public.brand_kits enable row level security;
alter table public.campaign_products enable row level security;

-- Make the new tables visible to the Supabase API right away.
notify pgrst, 'reload schema';
