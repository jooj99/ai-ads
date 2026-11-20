import "server-only";

import { supabase } from "@/lib/supabase/server";

/**
 * Private bucket for generated ads. Each ad version is `<campaign id>/<ad id>.png`
 * (the full image, for Download and Preview) plus `<ad id>.webp`, the small
 * preview the app shows (lib/ads/webp.ts).
 */
export const AD_BUCKET = "ads";

export const AD_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

/** The preview's path next to a full image's path. */
export function previewPath(imagePath: string) {
  return imagePath.replace(/\.png$/, ".webp");
}

/** Where the app serves an ad image (signed-in only, see app/api/campaigns/[id]/ads/[file]). */
export function adImageUrl(campaignId: string, imagePath: string) {
  return `/api/campaigns/${campaignId}/ads/${imagePath.split("/").pop()}`;
}

export async function deleteAdFiles(campaignId: string, names?: string[]): Promise<void> {
  const bucket = supabase().storage.from(AD_BUCKET);
  let files = names;
  if (!files) {
    const { data, error } = await bucket.list(campaignId, { limit: 1000 });
    if (error) throw error;
    files = (data ?? []).map((f) => f.name);
  }
  // Each ad's preview goes with it.
  files = [...new Set(files.flatMap((name) => [name, previewPath(name)]))];
  if (!files.length) return;
  const { error } = await bucket.remove(files.map((name) => `${campaignId}/${name}`));
  if (error) throw error;
}
