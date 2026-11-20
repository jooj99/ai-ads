-- Ads get a number per campaign ("Ad 3") that the user and agent can use to
-- refer to them; every version of an ad shares its original's number. Numbers
-- come from a counter on the campaign, so they never repeat, even after an
-- ad is deleted. `run_id` is the agent run that's making the ad, so stopping
-- that run can cancel it.
alter table public.campaigns add column ad_counter int not null default 0;

alter table public.campaign_ads
  add column number int,
  add column run_id text;

create index campaign_ads_by_run on public.campaign_ads (run_id) where status = 'generating';

create or replace function public.number_campaign_ad() returns trigger
language plpgsql as $$
begin
  if new.number is not null then
    return new;
  end if;
  if new.parent_id is not null then
    select number into new.number from public.campaign_ads where id = new.parent_id;
  end if;
  if new.number is null then
    -- The row lock on the campaign serializes parallel inserts.
    update public.campaigns set ad_counter = ad_counter + 1
    where id = new.campaign_id
    returning ad_counter into new.number;
  end if;
  return new;
end;
$$;

create trigger campaign_ads_number before insert on public.campaign_ads
for each row execute function public.number_campaign_ad();

-- Number existing ads: originals by age, versions inherit.
with recursive originals as (
  select id, campaign_id, row_number() over (partition by campaign_id order by created_at) as n
  from public.campaign_ads where parent_id is null
), tree as (
  select o.id, o.n from originals o
  union all
  select a.id, t.n from public.campaign_ads a join tree t on a.parent_id = t.id
)
update public.campaign_ads a set number = t.n from tree t where a.id = t.id;

update public.campaigns c set ad_counter = coalesce((select max(number) from public.campaign_ads a where a.campaign_id = c.id), 0);

notify pgrst, 'reload schema';
