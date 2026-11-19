-- A campaign keeps every headline the user saves, not just one: picked from
-- the agent's options (any number, from any set the agent proposed) or
-- written by the user. Generate will make ads for each saved headline.
create table public.campaign_headlines (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  headline text not null,
  cta text not null,
  -- 'agent' when picked from the agent's options, 'user' when the user wrote it.
  source text not null check (source in ('agent', 'user')),
  -- The proposeHeadlines tool call it was picked or written under, if any, so
  -- each choice card in the chat can show its own selections.
  proposal_id text,
  created_at timestamptz not null default now(),
  -- Saving the same copy twice is a no-op; also serves lookups by campaign.
  unique (campaign_id, headline, cta)
);

alter table public.campaign_headlines enable row level security;

grant select, insert, update, delete on public.campaign_headlines to service_role;

-- Carry over the single headline the previous version stored on the campaign.
insert into public.campaign_headlines (campaign_id, headline, cta, source)
select id, headline, cta, 'agent'
from public.campaigns
where headline is not null and cta is not null;

alter table public.campaigns
  drop column headline,
  drop column cta;

notify pgrst, 'reload schema';
