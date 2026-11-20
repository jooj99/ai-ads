-- Images the user attaches in the chat (references: "add this to the ad").
-- Private: the app serves them signed-in only at
-- /api/campaigns/<id>/uploads/<file>, and hands the agent's model and fal
-- short-lived signed URLs. Files are <campaign id>/<uuid>.<ext>.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-uploads', 'chat-uploads', false, 10485760, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;
