import "server-only";

import sharp from "sharp";

/**
 * Smaller copies of ads, to cut Supabase Storage egress.
 *
 * - Working files (drafts, repair edits, marked copies, an edit's base):
 *   full-size WebP at high quality, about 1 MB instead of a 6–7 MB PNG. Our
 *   server and fal download these several times while an ad is being made.
 * - Previews: 1080px-wide WebP (~150–250 KB) the app shows in the rail, the
 *   studio and the chat. The full PNG is only fetched for Download and
 *   Preview.
 */

const WORK_QUALITY = 92;
const PREVIEW_WIDTH = 1080;
const PREVIEW_QUALITY = 82;

export const WEBP = "image/webp";

/** Whether the bytes are already a WebP file (RIFF….WEBP). */
export function isWebp(bytes: Uint8Array): boolean {
  return (
    bytes.length > 12 &&
    String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === "RIFF" &&
    String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === "WEBP"
  );
}

/** A full-size working copy as WebP. A WebP is kept as is, so it isn't compressed twice. */
export async function workWebp(bytes: Uint8Array): Promise<Uint8Array> {
  if (isWebp(bytes)) return bytes;
  return new Uint8Array(await sharp(bytes).webp({ quality: WORK_QUALITY }).toBuffer());
}

/** The small WebP the app shows in place of the full PNG. */
export async function previewWebp(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp(bytes)
      .resize({ width: PREVIEW_WIDTH, withoutEnlargement: true })
      .webp({ quality: PREVIEW_QUALITY })
      .toBuffer(),
  );
}

/** A finished ad as PNG (the stored, downloadable file). A PNG is kept as is. */
export async function asPng(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return bytes;
  return new Uint8Array(await sharp(bytes).png().toBuffer());
}
