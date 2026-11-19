-- The campaign page is a chat with the ad agent. Its thread is stored as the
-- AI SDK's UI messages (text and tool parts, including the headline choices
-- and the user's pick), one row per campaign.
create table public.campaign_chats (
  campaign_id uuid primary key references public.campaigns (id) on delete cascade,
  messages jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.campaign_chats enable row level security;

-- The headline and call to action the user chose for the campaign's ads.
-- Generate reads these; the chat thread keeps the history of how they were picked.
alter table public.campaigns
  add column headline text,
  add column cta text;

grant select, insert, update, delete on public.campaign_chats to service_role;

notify pgrst, 'reload schema';
