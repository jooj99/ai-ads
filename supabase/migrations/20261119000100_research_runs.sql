-- Research now runs in the background, independent of any open page, so a
-- campaign needs a guard against two runs at once (double clicks, two tabs).

alter table public.campaigns add column research_started_at timestamptz;

-- Atomically claims a campaign for a research run. Succeeds when nothing is
-- running, or when the last run went quiet for 5 minutes (it crashed or its
-- function was stopped). Returns true when the caller should run research.
create or replace function public.claim_research(p_campaign_id uuid)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with claimed as (
    update public.campaigns
    set status = 'researching',
        research_started_at = now(),
        updated_at = now()
    where id = p_campaign_id
      and (
        status <> 'researching'
        or research_started_at is null
        or research_started_at < now() - interval '5 minutes'
      )
    returning id
  )
  select exists (select 1 from claimed);
$$;

revoke execute on function public.claim_research(uuid) from public, anon, authenticated;
grant execute on function public.claim_research(uuid) to service_role;

notify pgrst, 'reload schema';
