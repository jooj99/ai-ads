-- What an ad being made is doing right now ("Drafting the image", "Fixing
-- the logo (round 1 of 3)", "Applying 2 comments"), shown in the chat and
-- the studio while it's generating.
alter table campaign_ads add column if not exists stage text;

notify pgrst, 'reload schema';
