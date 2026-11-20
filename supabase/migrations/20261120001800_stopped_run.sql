-- The agent run the user last stopped. Ads that run is still preparing (no
-- row yet when the stop came) check it and don't start.
alter table campaigns add column if not exists stopped_run_id text;

notify pgrst, 'reload schema';
