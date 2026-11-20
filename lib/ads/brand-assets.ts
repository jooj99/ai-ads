import "server-only";

import { createHash } from "node:crypto";

import sharp from "sharp";

import { AD_BUCKET } from "@/lib/ads/store";
import { loads } from "@/lib/ads/render";
import type { BrandColor, BrandKit, BrandVisual } from "@/lib/research/types";
import { isPublicHttpUrl } from "@/lib/research/url";
import { supabase } from "@/lib/supabase/server";

/**
 * The brand kit as images Nano Banana can take as context:
 * - the logo, always as a PNG: fetched from the site, rendered if it's an
 *   SVG (the model can't read SVG), put on a solid background if it's
 *   transparent (see `onSolidBackground`), and stored in our `ads` bucket so
 *   fal never depends on the site serving it;
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
  if (!logo) return null;
  try {
    const bytes = await logoBytes(logo);
    if (!bytes) return null;
    const source = rasterSource(bytes);
    if (!source) return null;
    // SVGs render at high density so small viewBoxes come out crisp.
    const sized = await sharp(source, { density: 300 })
      .resize(LOGO_MAX, LOGO_MAX, { fit: "inside", withoutEnlargement: !isSvg(source) })
      .png()
      .toBuffer();
    const png = await onSolidBackground(sized);
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

/**
 * The logo file's bytes: fetched from the site, or decoded when the site
 * inlines it as a data: URL (many inline their SVG logo, e.g. Anthropic).
 */
async function logoBytes(logo: string): Promise<Buffer | null> {
  const inline = logo.match(/^data:image\/[\w+.-]+(;charset=[\w-]+)?(;base64)?,([\s\S]*)$/);
  if (inline) {
    const [, , base64, data] = inline;
    return base64 ? Buffer.from(data, "base64") : Buffer.from(decodeURIComponent(data), "utf8");
  }
  if (!isPublicHttpUrl(logo)) return null;
  const res = await fetch(logo, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8_000) });
  return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
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

/**
 * A transparent logo on a solid background that shows it: white behind a
 * dark mark, near-black behind a light one (by the average brightness of
 * its visible pixels), with a margin around it. The image model doesn't
 * reliably read transparency: Loopy Cases' dark-grey wordmark on
 * transparency came back as light letters in a dark box. Opaque logos are
 * returned as they are.
 */
async function onSolidBackground(png: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let seen = 0;
  let clear = 0;
  let light = 0;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    if (alpha < 0.98) clear++;
    if (alpha < 0.5) continue;
    seen++;
    light += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
  }
  const pixels = data.length / 4;
  if (!seen || clear / pixels < 0.02) return png; // already opaque
  const background = light / seen < 0.6 ? "#ffffff" : "#111111";
  const pad = Math.round(Math.max(info.width, info.height) * 0.08);
  return sharp(png)
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .flatten({ background })
    .png()
    .toBuffer();
}

/**
 * Bytes sharp can read. Sites often name a favicon as their logo, and sharp
 * can't read .ico files, so for those this takes the largest PNG image
 * inside (modern icons store PNGs); null if there's none.
 */
export function rasterSource(bytes: Buffer): Buffer | null {
  const isIco = bytes.length > 6 && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1;
  if (!isIco) return bytes;
  let best: Buffer | null = null;
  let bestSize = -1;
  for (let i = 0, n = bytes.readUInt16LE(4); i < n; i++) {
    const entry = 6 + i * 16;
    if (entry + 16 > bytes.length) break;
    const size = (bytes[entry] || 256) * (bytes[entry + 1] || 256);
    const length = bytes.readUInt32LE(entry + 8);
    const offset = bytes.readUInt32LE(entry + 12);
    const image = bytes.subarray(offset, offset + length);
    const png = image.length > 8 && image.readUInt32BE(0) === 0x89504e47;
    if (png && size > bestSize) {
      best = Buffer.from(image);
      bestSize = size;
    }
  }
  return best;
}

function isSvg(bytes: Buffer) {
  const head = bytes.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"));
}

/**
 * The brand's own graphics for a minimal ad whose visual is a brand graphic:
 * the kit's `visuals`, found and classified by research
 * (lib/research/visuals.ts, a vision model decides what each image is),
 * best first. Only ones that still load, at most `max`. Never throws.
 */
export async function brandGraphics(kit: BrandKit, max = 4): Promise<BrandGraphic[]> {
  const found: BrandGraphic[] = [];
  for (const visual of kit.visuals ?? []) {
    if (found.length >= max) break;
    const image = await visualImage(visual);
    if (image) found.push({ ...image, description: visual.description });
  }
  return found;
}

/** A brand visual ready for the image model: a URL it can fetch, and what the ad row records. */
export type BrandGraphic = { url: string; recorded: string; description: string };

/** A brand visual (an image on the brand's site) if it still loads for the image model. Never throws. */
export async function visualImage(visual: BrandVisual): Promise<{ url: string; recorded: string } | null> {
  try {
    return (await loads(visual.url)) ? { url: visual.url, recorded: visual.url } : null;
  } catch {
    return null;
  }
}
