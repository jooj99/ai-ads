-- What the check after generation found (lib/ads/verify.ts): the problems in
-- the first image (wrong logo, fake product, invented screen), whether a fix
-- was applied before the ad was shown, and anything still wrong after it.
alter table public.campaign_ads add column verification jsonb;

notify pgrst, 'reload schema';
