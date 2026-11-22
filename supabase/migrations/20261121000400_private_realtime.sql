-- Realtime broadcasts become private channels (lib/realtime.ts). Joining a
-- private channel is authorized by RLS on realtime.messages:
-- - signed-in users (the demo login) may receive broadcasts on any topic;
-- - there's no insert policy, so no browser can send one. The server sends
--   with the secret key (service_role), which RLS doesn't restrict.
-- Signed-out visitors can't join at all. The publishable key is public (it
-- ships in the page), so before this anyone could listen to campaign names
-- and progress, or post fake updates to open pages.

create policy "signed-in users receive broadcasts"
  on realtime.messages
  for select
  to authenticated
  using (realtime.messages.extension = 'broadcast');
