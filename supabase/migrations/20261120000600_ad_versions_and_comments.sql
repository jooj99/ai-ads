-- Ads get versions and pinned comments.
--
-- An edit makes a new ad row whose parent is the version it was made from,
-- so the original stays (a version history per ad). `instruction` is the
-- feedback that version applied.
alter table public.campaign_ads
  add column parent_id uuid references public.campaign_ads (id) on delete set null,
  add column instruction text;

create index campaign_ads_by_parent on public.campaign_ads (parent_id);

-- A comment pinned to a spot on one ad version: x and y are fractions of the
-- image's width and height (0–1), so pins stay put at any display size.
-- 'open' until an edit applies it; then 'applied', with the version it made.
create table public.ad_comments (
  id uuid primary key default gen_random_uuid(),
  ad_id uuid not null references public.campaign_ads (id) on delete cascade,
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  x real not null check (x >= 0 and x <= 1),
  y real not null check (y >= 0 and y <= 1),
  body text not null check (length(body) between 1 and 500),
  status text not null default 'open' check (status in ('open', 'applied')),
  applied_ad_id uuid references public.campaign_ads (id) on delete set null,
  created_at timestamptz not null default now()
);

create index ad_comments_by_ad on public.ad_comments (ad_id, created_at);

alter table public.ad_comments enable row level security;

grant select, insert, update, delete on public.ad_comments to service_role;

notify pgrst, 'reload schema';
