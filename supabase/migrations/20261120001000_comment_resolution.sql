-- After an edit applies a comment, the user says whether it worked:
-- 'resolved' (yes), or 'unresolved' (no: the same comment is re-opened as a
-- new 'open' comment on the ad's newest version, so it can be applied again).
alter table public.ad_comments drop constraint ad_comments_status_check;
alter table public.ad_comments
  add constraint ad_comments_status_check check (status in ('open', 'applied', 'resolved', 'unresolved'));
alter table public.ad_comments add column reviewed_at timestamptz;

create index ad_comments_by_applied on public.ad_comments (applied_ad_id);

notify pgrst, 'reload schema';
