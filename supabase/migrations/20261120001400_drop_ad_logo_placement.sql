-- Logos are drawn by the image model again (from the real logo image), not
-- placed by code, so ads no longer keep a logo-free copy or a placement.
-- Undoes 20261120001300_ad_logo_placement; those copies were deleted from
-- the `ads` bucket first.
alter table public.campaign_ads
  drop column if exists base_path,
  drop column if exists logo;

notify pgrst, 'reload schema';
