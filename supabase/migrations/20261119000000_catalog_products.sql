-- campaign_products now holds the whole researched catalog, not just the
-- hero picks: heroes are flagged so the UI can filter to them, and every row
-- carries the type the model grouped it into.

alter table public.campaign_products
  add column is_hero boolean not null default false;

-- Rows saved before this migration were all hero picks.
update public.campaign_products set is_hero = true;

notify pgrst, 'reload schema';
