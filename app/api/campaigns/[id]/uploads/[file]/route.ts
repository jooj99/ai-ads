import { supabase } from "@/lib/supabase/server";
import { unauthorized } from "@/lib/supabase/auth";
import { isUploadName, UPLOAD_BUCKET, UPLOAD_TYPES } from "@/lib/uploads";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Serves an image the user attached in the chat (signed-in only; names never change, so cache for good). */
export async function GET(_req: Request, ctx: RouteContext<"/api/campaigns/[id]/uploads/[file]">) {
  const denied = await unauthorized();
  if (denied) return denied;
  const { id, file } = await ctx.params;
  if (!UUID.test(id) || !isUploadName(file)) return new Response("Not found", { status: 404 });

  const { data, error } = await supabase().storage.from(UPLOAD_BUCKET).download(`${id}/${file}`);
  if (error || !data) return new Response("Not found", { status: 404 });
  return new Response(data, {
    headers: {
      "content-type": UPLOAD_TYPES[file.split(".").pop()!] ?? "application/octet-stream",
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
