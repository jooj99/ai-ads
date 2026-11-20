/**
 * The small WebP preview of an ad (`<ad id>.webp`, next to its full
 * `<ad id>.png`). The app shows previews; Download and Preview use the PNG.
 * Older ads get their preview made the first time it's asked for (see
 * app/api/campaigns/[id]/ads/[file]).
 */
export function adPreviewUrl(url: string): string {
  return url.replace(/\.png(?=$|\?)/, ".webp");
}
