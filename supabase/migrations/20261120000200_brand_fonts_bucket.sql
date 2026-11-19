-- Brand font files scraped from each site's @font-face rules. Brands often
-- use licensed fonts that Google Fonts doesn't have, and many sites block
-- loading their font files from other origins, so research copies them here.
-- The bucket is private: the app serves files through
-- /api/campaigns/<id>/fonts/<file> with the secret key, never publicly.
insert into storage.buckets (id, name, public, file_size_limit)
values ('brand-fonts', 'brand-fonts', false, 2097152)
on conflict (id) do nothing;
