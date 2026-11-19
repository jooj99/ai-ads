import { FONT_BUCKET, FONT_TYPES } from "@/lib/research/font-store";
import { supabase } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE = /^[a-z0-9-]+\.(woff2|woff|ttf|otf)$/;

/**
 * Serves a campaign's brand font from private storage (copied there by
 * research, see font-store.ts). Same-origin, so the browser can always load
 * it, unlike the site's own CDN. File names include a hash of their bytes,
 * so responses are cached for good.
 */
export async function GET(_req: Request, ctx: RouteContext<"/api/campaigns/[id]/fonts/[file]">) {
  const { id, file } = await ctx.params;
  const ext = file.match(FILE)?.[1];
  if (!UUID.test(id) || !ext) return new Response("Not found", { status: 404 });

  const { data, error } = await supabase().storage.from(FONT_BUCKET).download(`${id}/${file}`);
  if (error || !data) return new Response("Not found", { status: 404 });

  return new Response(data, {
    headers: {
      "content-type": FONT_TYPES[ext] ?? "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
