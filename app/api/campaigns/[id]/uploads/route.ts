import { randomUUID } from "node:crypto";

import { getCampaign } from "@/lib/campaigns";
import { supabase } from "@/lib/supabase/server";
import { unauthorized } from "@/lib/supabase/auth";
import { MAX_UPLOAD_BYTES, sniffImage, UPLOAD_BUCKET, uploadUrl } from "@/lib/uploads";

/**
 * Stores an image the user attached in the chat (multipart field `file`).
 * Checks it's really a PNG, JPEG or WebP by its bytes, and returns the file
 * part the chat sends: our own URL, its type and the original name.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/campaigns/[id]/uploads">) {
  const denied = await unauthorized();
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!(await getCampaign(id).catch(() => null))) return Response.json({ error: "Unknown campaign." }, { status: 404 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return Response.json({ error: "No image attached." }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return Response.json({ error: "Images can be up to 4 MB." }, { status: 413 });

  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniffImage(bytes);
  if (!kind) return Response.json({ error: "Only PNG, JPEG and WebP images can be attached." }, { status: 415 });

  const name = `${randomUUID()}.${kind.ext}`;
  const { error } = await supabase()
    .storage.from(UPLOAD_BUCKET)
    .upload(`${id}/${name}`, bytes, { contentType: kind.type });
  if (error) {
    console.error("[uploads] storing failed", error);
    return Response.json({ error: "The image couldn't be saved. Try again." }, { status: 500 });
  }
  return Response.json({
    type: "file",
    mediaType: kind.type,
    url: uploadUrl(id, name),
    filename: file.name.slice(0, 120) || name,
  });
}
