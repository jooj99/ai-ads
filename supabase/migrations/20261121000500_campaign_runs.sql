-- Which campaign each agent run (research or a chat turn) belongs to. The
-- chat's stop and reconnect routes take a run id from the URL; they check it
-- here, so a run id from one campaign can't be stopped or read through
-- another campaign's URL. Server-only, like every table (RLS, no policies).

create table public.campaign_runs (
  run_id text primary key,
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index campaign_runs_campaign_id_idx on public.campaign_runs (campaign_id);

alter table public.campaign_runs enable row level security;

grant select, insert, update, delete on public.campaign_runs to service_role;

notify pgrst, 'reload schema';
