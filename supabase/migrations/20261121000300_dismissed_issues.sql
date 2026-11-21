-- Warnings the user dismissed on an ad version, one by one: the check's
-- remaining problems (by their text) and "unchecked" for the not-checked note.
-- Dismissed ones no longer show on the ad, its rail badge, the chat or the
-- agent's ads list.
alter table public.campaign_ads add column dismissed_issues text[] not null default '{}';

notify pgrst, 'reload schema';
