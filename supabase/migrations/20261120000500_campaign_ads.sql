-- Generated ads. Each row is one 9:16 image made by fal (Nano Banana Pro
-- edit) from a saved headline, the brand kit and hero product photos. fal's
-- URLs aren't durable, so the image is copied into the private `ads` bucket
-- and served through /api/campaigns/<id>/ads/<file> (signed-in only).
create table public.campaign_ads (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  headline text not null,
  cta text not null,
  -- Catalog source ids of the products whose photos went in.
  product_ids text[] not null default '{}',
  -- Exactly what was sent to the model, for review and regeneration.
  prompt text not null,
  system_prompt text not null default '',
  image_inputs text[] not null default '{}',
  model text not null,
  status text not null default 'generating' check (status in ('generating', 'ready', 'failed')),
  -- Path in the `ads` bucket once ready, e.g. <campaign id>/<ad id>.png
  image_path text,
  width int,
  height int,
  error text,
  fal_request_id text,
  -- The agent tool call that asked for it: a retried workflow step finds its
  -- earlier row instead of paying for a second image.
  tool_call_id text unique,
  created_at timestamptz not null default now()
);

create index campaign_ads_by_campaign on public.campaign_ads (campaign_id, created_at desc);

alter table public.campaign_ads enable row level security;

grant select, insert, update, delete on public.campaign_ads to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ads', 'ads', false, 26214400, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

notify pgrst, 'reload schema';
