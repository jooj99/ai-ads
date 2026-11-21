-- What a vision model read from a product's own photos and description, once:
-- what it is, its parts and how they attach, how it's used, what it doesn't
-- have. The ad brief, the idea playbook and the ad check use it, so a product
-- is staged and judged the way it really works. Null until it's needed.
alter table public.campaign_products add column notes jsonb;

notify pgrst, 'reload schema';
