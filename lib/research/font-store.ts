import "server-only";

import { createHash } from "node:crypto";

import { listAll, removeAll } from "@/lib/storage";
import { supabase } from "@/lib/supabase/server";

import type { BrandFont, FontFile } from "./types";
import { assetHeaders } from "./html-signals";
import { isPublicHttpUrl } from "./url";
import { publicFetch } from "@/lib/research/public-fetch";

export const FONT_BUCKET = "brand-fonts";

const MAX_FONT_BYTES = 2 * 1024 * 1024;

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
  try {
    const got = await download(file, siteUrl);
    if (!got) return null;
    const { bytes, kind } = got;

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

/**
 * Downloads a font file like the site's own page would: browser headers,
 * with the stylesheet that declared it as the Referer (as browsers send),
 * then the page itself. Tries the declared file, then the same face in the
 * other formats the site lists. Returns null (and says why) when every try
 * fails, e.g. when a brand blocks downloads of its licensed font.
 */
async function download(file: FontFile, siteUrl: string): Promise<{ bytes: Buffer; kind: (typeof SIGNATURES)[number] } | null> {
  const urls = [file.source, ...(file.alternates ?? [])].filter(isPublicHttpUrl);
  const referers = [...new Set([file.referer, siteUrl].filter((r): r is string => Boolean(r)))];
  const failures: string[] = [];
  for (const url of urls) {
    for (const referer of referers) {
      try {
        const res = await publicFetch(url, { headers: assetHeaders("font", url, referer), signal: AbortSignal.timeout(10_000) });
        if (!res.ok) {
          failures.push(`HTTP ${res.status}`);
          continue;
        }
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.length === 0 || bytes.length > MAX_FONT_BYTES) {
          failures.push(`size ${bytes.length}`);
          continue;
        }
        const kind = SIGNATURES.find((s) => s.magic === bytes.subarray(0, 4).toString("latin1"));
        if (!kind) {
          failures.push("not a font file");
          continue;
        }
        return { bytes, kind };
      } catch (error) {
        failures.push(error instanceof Error ? error.message : "fetch failed");
      }
    }
  }
  const blocked = failures.length > 0 && failures.every((f) => f === "HTTP 403" || f === "HTTP 401");
  console.warn(
    `[research] ${blocked ? "the site blocks downloads of" : "couldn't download"} font file ${file.source} (${[...new Set(failures)].join(", ")})`,
  );
  return null;
}

/** Deletes a campaign's stored font files (when the campaign is deleted). */
export async function deleteFontFiles(campaignId: string): Promise<void> {
  const names = await listAll(FONT_BUCKET, campaignId);
  await removeAll(FONT_BUCKET, names.map((name) => `${campaignId}/${name}`));
}
