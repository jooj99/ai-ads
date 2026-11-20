import { AD_BUCKET, AD_TYPES } from "@/lib/ads/store";
import { supabase } from "@/lib/supabase/server";
import { unauthorized } from "@/lib/supabase/auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE = /^[0-9a-f-]{36}\.(png|jpg|webp)$/i;

/**
 * Serves a generated ad from the private `ads` bucket (copied there from fal,
 * see lib/ads/generate.ts). Signed-in only. Each ad has its own file name, so
 * the browser may keep it for good.
 */
export async function GET(_req: Request, ctx: RouteContext<"/api/campaigns/[id]/ads/[file]">) {
  const denied = await unauthorized();
  if (denied) return denied;
  const { id, file } = await ctx.params;
  const ext = file.match(FILE)?.[1]?.toLowerCase();
  if (!UUID.test(id) || !ext) return new Response("Not found", { status: 404 });

  const { data, error } = await supabase().storage.from(AD_BUCKET).download(`${id}/${file}`);
  if (error || !data) return new Response("Not found", { status: 404 });

  return new Response(data, {
    headers: {
      "content-type": AD_TYPES[ext] ?? "application/octet-stream",
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
