import { AD_BUCKET, AD_TYPES } from "@/lib/ads/store";
import { previewWebp, WEBP } from "@/lib/ads/webp";
import { supabase } from "@/lib/supabase/server";
import { unauthorized } from "@/lib/supabase/auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE = /^[0-9a-f-]{36}\.(png|jpg|webp)$/i;

/**
 * Serves a generated ad from the private `ads` bucket (copied there from fal,
 * see lib/ads/generate.ts): `<ad id>.png` is the full image, `<ad id>.webp`
 * its small preview. Signed-in only. Each ad has its own file name, so the
 * browser may keep it for good.
 */
export async function GET(_req: Request, ctx: RouteContext<"/api/campaigns/[id]/ads/[file]">) {
  const denied = await unauthorized();
  if (denied) return denied;
  const { id, file } = await ctx.params;
  const ext = file.match(FILE)?.[1]?.toLowerCase();
  if (!UUID.test(id) || !ext) return new Response("Not found", { status: 404 });

  const bucket = supabase().storage.from(AD_BUCKET);
  const { data, error } = await bucket.download(`${id}/${file}`);
  let body: Blob | Uint8Array | undefined = !error && data ? data : undefined;
  // An ad made before previews existed: make its preview from the PNG once,
  // store it, and serve it (later requests get the stored one).
  if (!body && ext === "webp") {
    const png = await bucket.download(`${id}/${file.replace(/\.webp$/i, ".png")}`);
    if (!png.error && png.data) {
      body = await previewWebp(new Uint8Array(await png.data.arrayBuffer()));
      const stored = await bucket.upload(`${id}/${file}`, body, { contentType: WEBP, upsert: true });
      if (stored.error) console.warn(`[ads] storing a preview failed (${stored.error.message})`);
    }
  }
  if (!body) return new Response("Not found", { status: 404 });

  return new Response(body as BodyInit, {
    headers: {
      "content-type": AD_TYPES[ext] ?? "application/octet-stream",
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
