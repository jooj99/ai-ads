-- This project doesn't grant table privileges to API roles by default, so the
-- server's role needs explicit grants. Only service_role (used with the secret
-- key on the server) gets access; anon and authenticated get nothing, on top
-- of RLS having no policies.

grant select, insert, update, delete
  on public.campaigns, public.brand_kits, public.campaign_products
  to service_role;

notify pgrst, 'reload schema';
