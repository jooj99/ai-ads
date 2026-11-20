import "server-only";

import { supabase } from "@/lib/supabase/server";

/**
 * Images the user attaches in the chat, kept in the private `chat-uploads`
 * bucket as `<campaign id>/<uuid>.<ext>`.
 *
 * In messages they're file parts whose URL is our own route,
 * `/api/campaigns/<id>/uploads/<file>`, so threads stay small (no base64)
 * and the images stay private. The model and fal can't reach that route, so
 * each agent run swaps in short-lived signed URLs (`signUploads`). The file
 * name is also the reference id the agent passes to the ad tools.
 */

export const UPLOAD_BUCKET = "chat-uploads";
export const UPLOAD_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

const FILE = /^[0-9a-f-]{36}\.(png|jpg|webp)$/;

export function uploadUrl(campaignId: string, name: string) {
  return `/api/campaigns/${campaignId}/uploads/${name}`;
}

/** The upload's file name if `url` is one of this campaign's uploads, else null. */
export function uploadName(campaignId: string, url: string): string | null {
  const prefix = `/api/campaigns/${campaignId}/uploads/`;
  if (!url.startsWith(prefix)) return null;
  const name = url.slice(prefix.length);
  return FILE.test(name) ? name : null;
}

export function isUploadName(name: string) {
  return FILE.test(name);
}

/** Image type from the first bytes; anything else is rejected. */
export function sniffImage(bytes: Uint8Array): { ext: string; type: string } | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { ext: "png", type: "image/png" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ext: "jpg", type: "image/jpeg" };
  const riff = String.fromCharCode(...bytes.slice(0, 4));
  const webp = String.fromCharCode(...bytes.slice(8, 12));
  if (riff === "RIFF" && webp === "WEBP") return { ext: "webp", type: "image/webp" };
  return null;
}

/** Signed URLs (by file name) the model and fal can fetch, for `seconds`. Missing files are left out. */
export async function signUploads(campaignId: string, names: string[], seconds = 60 * 60): Promise<Map<string, string>> {
  const unique = [...new Set(names.filter(isUploadName))];
  if (!unique.length) return new Map();
  const { data, error } = await supabase()
    .storage.from(UPLOAD_BUCKET)
    .createSignedUrls(
      unique.map((n) => `${campaignId}/${n}`),
      seconds,
    );
  if (error) throw error;
  const urls = new Map<string, string>();
  (data ?? []).forEach((d, i) => {
    if (d.signedUrl && !d.error) urls.set(unique[i], d.signedUrl);
  });
  return urls;
}

export async function deleteUploads(campaignId: string): Promise<void> {
  const bucket = supabase().storage.from(UPLOAD_BUCKET);
  const { data, error } = await bucket.list(campaignId, { limit: 1000 });
  if (error) throw error;
  if (data?.length) {
    const { error: removeError } = await bucket.remove(data.map((f) => `${campaignId}/${f.name}`));
    if (removeError) throw removeError;
  }
}

/** A reference the agent passes to an ad tool: an upload's name and how to use it. */
export type AdReference = { image: string; use: string };

/**
 * Turns the agent's references into URLs fal can fetch (15 minutes), keeping
 * their order. `missing` lists refs that aren't this campaign's uploads.
 * `recorded` is what the ad row stores instead of the signed URLs.
 */
export async function resolveReferences(campaignId: string, refs: AdReference[] = []) {
  const names = refs.map((r) => r.image.trim().split("/").pop() ?? "");
  const signed = await signUploads(campaignId, names, 15 * 60);
  const missing = refs.filter((_, i) => !signed.has(names[i])).map((r) => r.image);
  const found = refs.flatMap((r, i) => {
    const url = signed.get(names[i]);
    return url ? [{ url, use: r.use, recorded: `${UPLOAD_BUCKET}/${campaignId}/${names[i]}` }] : [];
  });
  return { found, missing };
}
