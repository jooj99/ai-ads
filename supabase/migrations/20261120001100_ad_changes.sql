-- For an edited version: what the edit actually changed, as short bullets
-- written by comparing the ad before and after (lib/ads/summarize.ts). Shown
-- as the version's "Changes" and returned to the agent. `instruction` keeps
-- what was asked for.
alter table public.campaign_ads add column changes text[];

notify pgrst, 'reload schema';
