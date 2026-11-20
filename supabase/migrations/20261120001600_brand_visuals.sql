-- The brand's own graphics (3D shapes, a mascot, illustrations, patterns),
-- found on its site and classified by research (lib/research/visuals.ts), for
-- minimal ads whose visual is a brand graphic: [{ url, description }].
alter table public.brand_kits add column visuals jsonb not null default '[]'::jsonb;

notify pgrst, 'reload schema';
