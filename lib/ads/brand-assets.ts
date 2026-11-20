import "server-only";

import { createHash } from "node:crypto";

import sharp from "sharp";

import { AD_BUCKET } from "@/lib/ads/store";
import type { BrandColor } from "@/lib/research/types";
import { isPublicHttpUrl } from "@/lib/research/url";
import { supabase } from "@/lib/supabase/server";

/**
 * The brand kit as images Nano Banana can take as context:
 * - the logo, always as a PNG: fetched from the site, rendered if it's an
 *   SVG (the model can't read SVG), and stored in our `ads` bucket so fal
 *   never depends on the site serving it;
 * - one solid square per brand color, so the model sees the exact color
 *   rather than reading a hex code (each is also named by hex in the prompt).
 * Files live at `<campaign>/logo-<hash>.png` and `<campaign>/swatch-<HEX>.png`
 * (deleted with the campaign) and go to fal as short-lived signed URLs.
 */

const SIGNED_SECONDS = 15 * 60;
const LOGO_MAX = 1024;
const SWATCH_SIZE = 256;
const UA = "Mozilla/5.0 (compatible; PloyAds/1.0)";

/** A brand image ready for fal: a signed URL, and the storage path the ad row records. */
export type BrandImage = { url: string; recorded: string };
export type Swatch = BrandImage & { hex: string; role: string; use: string };

/** The kit's logo as a PNG fal can fetch, or null if there's none or it can't be read. Never throws. */
export async function logoImage(campaignId: string, logo?: string): Promise<BrandImage | null> {
  if (!logo || !isPublicHttpUrl(logo)) return null;
  try {
    const res = await fetch(logo, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const source = Buffer.from(await res.arrayBuffer());
    // SVGs render at high density so small viewBoxes come out crisp.
    const png = await sharp(source, { density: 300 })
      .resize(LOGO_MAX, LOGO_MAX, { fit: "inside", withoutEnlargement: !isSvg(source) })
      .png()
      .toBuffer();
    const path = `${campaignId}/logo-${createHash("sha256").update(png).digest("hex").slice(0, 12)}.png`;
    const bucket = supabase().storage.from(AD_BUCKET);
    const upload = await bucket.upload(path, png, { contentType: "image/png", upsert: true });
    if (upload.error) throw upload.error;
    const signed = await bucket.createSignedUrl(path, SIGNED_SECONDS);
    if (signed.error || !signed.data) throw signed.error;
    return { url: signed.data.signedUrl, recorded: `${AD_BUCKET}/${path}` };
  } catch (error) {
    console.error("[ads] preparing the logo failed", error);
    return null;
  }
}

/** A solid square per brand color (up to `max`), with what each is for. Never throws. */
export async function swatchImages(campaignId: string, colors: BrandColor[], max = 6): Promise<Swatch[]> {
  const valid = colors.filter((c) => /^#[0-9a-f]{6}$/i.test(c.hex)).slice(0, max);
  if (!valid.length) return [];
  try {
    const bucket = supabase().storage.from(AD_BUCKET);
    const paths = await Promise.all(
      valid.map(async (c) => {
        const hex = c.hex.toUpperCase();
        const png = await sharp({
          create: { width: SWATCH_SIZE, height: SWATCH_SIZE, channels: 3, background: hex },
        })
          .png()
          .toBuffer();
        const path = `${campaignId}/swatch-${hex.slice(1)}.png`;
        const upload = await bucket.upload(path, png, { contentType: "image/png", upsert: true });
        if (upload.error) throw upload.error;
        return path;
      }),
    );
    const signed = await bucket.createSignedUrls(paths, SIGNED_SECONDS);
    if (signed.error) throw signed.error;
    return valid.flatMap((c, i) => {
      const url = signed.data?.[i]?.signedUrl;
      return url
        ? [{ url, recorded: `${AD_BUCKET}/${paths[i]}`, hex: c.hex.toUpperCase(), role: c.role, use: colorUse(c.role) }]
        : [];
    });
  } catch (error) {
    console.error("[ads] preparing color swatches failed", error);
    return [];
  }
}

/**
 * Where a color goes in an ad, from its role, so the model gets an
 * assignment ("the button is #0A7EA4") rather than a palette to pick from.
 */
export function colorUse(role: string): string {
  const r = role.toLowerCase();
  if (/primary|brand|main/.test(r)) return "call-to-action button fill and the main brand color";
  if (/accent|highlight/.test(r)) return "small highlights and details (sparingly)";
  if (/background|surface|base/.test(r)) return "backgrounds and large areas";
  if (/secondary/.test(r)) return "secondary areas: panels, overlays, dark or light backgrounds";
  if (/text|ink|foreground/.test(r)) return "text";
  return "supporting color";
}

function isSvg(bytes: Buffer) {
  const head = bytes.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"));
}
