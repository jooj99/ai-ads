import "server-only";

import { supabase } from "@/lib/supabase/server";

/** Private bucket for generated ads; files are `<campaign id>/<ad id>.<ext>`. */
export const AD_BUCKET = "ads";

export const AD_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

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
  if (!files.length) return;
  const { error } = await bucket.remove(files.map((name) => `${campaignId}/${name}`));
  if (error) throw error;
}
