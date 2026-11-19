-- Research steps now merge products into a campaign's catalog (add some,
-- replace research's own, keep the agent's and user's) instead of rewriting
-- the whole list. That needs a stable key per item, the site's id or URL,
-- and lets positions change freely.

-- Keep one row per (campaign, source_id): the earliest position.
delete from public.campaign_products p
using public.campaign_products q
where p.campaign_id = q.campaign_id
  and p.source_id = q.source_id
  and p.position > q.position;

alter table public.campaign_products
  drop constraint campaign_products_campaign_id_position_key,
  add constraint campaign_products_campaign_id_source_id_key unique (campaign_id, source_id);

notify pgrst, 'reload schema';
