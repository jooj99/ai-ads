import "server-only";

import { listAll, removeAll } from "@/lib/storage";

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
  // Each ad's preview goes with it.
  const files = [...new Set((names ?? (await listAll(AD_BUCKET, campaignId))).flatMap((name) => [name, previewPath(name)]))];
  await removeAll(AD_BUCKET, files.map((name) => `${campaignId}/${name}`));
}

/**
 * An ad's working files: its drafts and repairs (`work-<ad>-…`), the check's
 * repair copies (`check-<ad>-…`, `marks-check-<ad>-…`) and, for an edit, its
 * temporary copies (`edit-<call>` / `marks-<call>`). Each run deletes its own
 * as it ends; this is for one that never got to (stopped, or its run died).
 * Never throws.
 */
export async function removeAdWorkFiles(campaignId: string, adId: string, toolCallId?: string | null): Promise<void> {
  try {
    const found = await Promise.all(
      [`work-${adId}-`, `check-${adId}-`, `marks-check-${adId}-`].map((prefix) => listAll(AD_BUCKET, campaignId, prefix)),
    );
    const names = found.flat().map((name) => `${campaignId}/${name}`);
    if (toolCallId) names.push(`${campaignId}/edit-${toolCallId}.webp`, `${campaignId}/marks-${toolCallId}.webp`);
    await removeAll(AD_BUCKET, names);
  } catch (error) {
    console.warn(`[ads] removing work files of ${adId} failed`, error);
  }
}
