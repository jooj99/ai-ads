-- The logo is placed on ads by code (lib/ads/logo.ts) instead of being drawn
-- by the image model. Each ad keeps the image without the logo (`base_path`,
-- in the private `ads` bucket), which edits start from before the logo is
-- placed again, and where the logo went (`logo`: x, y, width, height in
-- pixels and the share of the mark recolored for contrast).
alter table public.campaign_ads
  add column base_path text,
  add column logo jsonb;

notify pgrst, 'reload schema';
