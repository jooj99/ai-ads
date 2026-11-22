-- Data model hardening, from an audit of the schema and its writes.

-- 1. Dismissing a warning on an ad is one statement. It used to read the
--    list, then write it back: two dismissals at once could lose one.
create or replace function public.dismiss_ad_issue(p_campaign_id uuid, p_ad_id uuid, p_issue text)
returns boolean
language sql
set search_path = ''
as $$
  with updated as (
    update public.campaign_ads
    set dismissed_issues = case
      when p_issue = any (dismissed_issues) then dismissed_issues
      else array_append(dismissed_issues, p_issue)
    end
    where id = p_ad_id and campaign_id = p_campaign_id
    returning id
  )
  select exists (select 1 from updated);
$$;
revoke execute on function public.dismiss_ad_issue(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.dismiss_ad_issue(uuid, uuid, text) to service_role;

-- 2. The ad-numbering trigger function gets a fixed search_path (its body
--    already names public.* tables) and can't be called through the API roles.
alter function public.number_campaign_ad() set search_path = '';
revoke execute on function public.number_campaign_ad() from public, anon, authenticated;

-- 3. A ready ad always has its image.
alter table public.campaign_ads
  add constraint campaign_ads_ready_has_image check (status <> 'ready' or image_path is not null);

-- 4. Deleting a campaign cascades to its comments by campaign_id: index it.
create index if not exists ad_comments_by_campaign on public.ad_comments (campaign_id);

-- 5. Only the server's role touches tables. RLS (no policies) already blocks
--    anon and authenticated; Supabase's default grants still gave them table
--    privileges, so revoke those too, now and for tables made later.
revoke all on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;

notify pgrst, 'reload schema';
