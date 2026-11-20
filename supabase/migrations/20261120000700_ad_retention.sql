-- For an edited version: the share of the ad (outside the pinned spots) that
-- still looks the same as the version it was edited from, 0–100. Edits that
-- drift too far are retried once and the closer result is kept.
alter table public.campaign_ads add column retained real;

notify pgrst, 'reload schema';
