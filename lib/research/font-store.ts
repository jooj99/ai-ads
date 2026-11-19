import "server-only";

import { createHash } from "node:crypto";

import { supabase } from "@/lib/supabase/server";

import type { BrandFont, FontFile } from "./types";
import { isPublicHttpUrl } from "./url";

export const FONT_BUCKET = "brand-fonts";

const MAX_FONT_BYTES = 2 * 1024 * 1024;
const UA = "Mozilla/5.0 (compatible; PloyAdsResearch/1.0)";

/** Font formats by their first bytes; anything else (HTML error pages, EOT) is rejected. */
const SIGNATURES: { magic: string; ext: string; type: string }[] = [
  { magic: "wOF2", ext: "woff2", type: "font/woff2" },
  { magic: "wOFF", ext: "woff", type: "font/woff" },
  { magic: "OTTO", ext: "otf", type: "font/otf" },
  { magic: "\u0000\u0001\u0000\u0000", ext: "ttf", type: "font/ttf" },
  { magic: "true", ext: "ttf", type: "font/ttf" },
];

export const FONT_TYPES: Record<string, string> = Object.fromEntries(
  SIGNATURES.map((s) => [s.ext, s.type]),
);

/**
 * Copies each brand font's files from the site into private storage, so the
 * app can serve them itself (sites often block other origins from loading
 * their fonts, and their URLs can change). Files are named by a hash of their
 * bytes, so a URL never changes meaning and can be cached forever. A file
 * that can't be fetched or isn't a real font is dropped; the font then falls
 * back to Google Fonts in the preview. Never throws.
 */
export async function storeFontFiles(
  campaignId: string,
  fonts: BrandFont[],
  siteUrl: string,
): Promise<BrandFont[]> {
  return Promise.all(
    fonts.map(async (font) => {
      if (!font.files?.length) return font;
      const files = await Promise.all(font.files.map((file) => storeOne(campaignId, font.family, file, siteUrl)));
      const stored = files.filter((f): f is FontFile => f !== null);
      return { ...font, files: stored.length ? stored : undefined };
    }),
  );
}

async function storeOne(
  campaignId: string,
  family: string,
  file: FontFile,
  siteUrl: string,
): Promise<FontFile | null> {
  if (file.url) return file; // already stored by an earlier run
  if (!isPublicHttpUrl(file.source)) return null;
  try {
    const res = await fetch(file.source, {
      // Some CDNs only serve fonts to their own pages.
      headers: { "user-agent": UA, referer: siteUrl, origin: new URL(siteUrl).origin },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_FONT_BYTES) throw new Error(`size ${bytes.length}`);
    const head = bytes.subarray(0, 4).toString("latin1");
    const kind = SIGNATURES.find((s) => s.magic === head);
    if (!kind) throw new Error("not a font file");

    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
    const slug = family.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "font";
    const name = `${slug}-${file.weight}-${hash}.${kind.ext}`;
    const { error } = await supabase()
      .storage.from(FONT_BUCKET)
      .upload(`${campaignId}/${name}`, bytes, { contentType: kind.type, upsert: true });
    if (error) throw error;
    return { ...file, url: `/api/campaigns/${campaignId}/fonts/${name}` };
  } catch (error) {
    console.error(`[research] couldn't store font file for ${family}`, file.source, error);
    return null;
  }
}

/** Deletes a campaign's stored font files (when the campaign is deleted). */
export async function deleteFontFiles(campaignId: string): Promise<void> {
  const bucket = supabase().storage.from(FONT_BUCKET);
  const { data, error } = await bucket.list(campaignId, { limit: 1000 });
  if (error) throw error;
  if (data?.length) {
    const { error: removeError } = await bucket.remove(data.map((f) => `${campaignId}/${f.name}`));
    if (removeError) throw removeError;
  }
}
