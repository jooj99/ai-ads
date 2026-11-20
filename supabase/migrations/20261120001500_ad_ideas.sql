-- Ads made from a picked creative idea record it (title, concept, scene,
-- what it shows off), so the studio can show which idea an ad came from.
alter table public.campaign_ads add column idea jsonb;

notify pgrst, 'reload schema';
