import Firecrawl, { type BrandingProfile } from "@mendable/firecrawl-js";

import type { BrandColor, BrandFont, Product } from "./types";
import { absoluteUrl } from "./url";

/** What one homepage read yields, whichever way it was read. */
export type PageResearch = {
  /** "firecrawl" when the brand extractor ran; "html" for the plain-fetch fallback. */
  source: "firecrawl" | "html";
  title?: string;
  description?: string;
  siteName?: string;
  logo?: string;
  logoCandidates: string[];
  colors: BrandColor[];
  fonts: BrandFont[];
  /** Page copy for the model to read: markdown from Firecrawl, plain text otherwise. */
  content: string;
  links: string[];
  /** Firecrawl's own read of tone and personality, passed to the model as a hint. */
  styleHints?: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function firecrawlClient(): Firecrawl | null {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  return apiKey ? new Firecrawl({ apiKey }) : null;
}

/**
 * Reads the homepage with Firecrawl: markdown for the copy, `branding` for
 * logo, colors and fonts from the rendered page, and links for finding
 * product pages on non-Shopify sites. Cached copies up to a day old are fine.
 */
export async function scrapeWithFirecrawl(fc: Firecrawl, url: URL): Promise<PageResearch> {
  const doc = await fc.scrape(url.href, {
    formats: ["markdown", "branding", "links"],
    maxAge: DAY_MS,
    timeout: 60_000,
  });
  const base = doc.metadata?.sourceURL ?? url.href;
  const meta = (doc.metadata ?? {}) as Record<string, unknown>;
  const branding = doc.branding;

  // Favicons are tiny tab icons and og:images are usually photos, so a real
  // logo always wins; the rest are fallbacks the UI walks through in order.
  const isFavicon = (u: string) => /favicon|\.ico(\?|$)/i.test(u);
  const ogImage = absoluteUrl(branding?.images?.ogImage ?? str(meta.ogImage), base);
  const logos = unique([
    absoluteUrl(branding?.logo, base),
    absoluteUrl(branding?.images?.logo, base),
    absoluteUrl(branding?.images?.favicon ?? str(meta.favicon), base),
  ]);
  const logoCandidates = unique([
    ...logos.filter((u) => !isFavicon(u)),
    ...logos.filter(isFavicon),
    ogImage,
  ]);

  return {
    source: "firecrawl",
    title: str(meta.title),
    description: str(meta.description) ?? str(meta.ogDescription),
    siteName: branding?.brandName ?? str(meta.ogSiteName),
    logo: logoCandidates[0],
    logoCandidates,
    colors: colorsFromBranding(branding),
    fonts: fontsFromBranding(branding),
    content: doc.markdown ?? "",
    links: doc.links ?? [],
    styleHints: styleHintsFromBranding(branding),
  };
}

/**
 * Fallback when Firecrawl is unavailable or fails: fetch the HTML ourselves
 * and read what the markup declares (meta tags, structured data, CSS). Less
 * accurate than rendered branding, but the user still gets a starting kit.
 */
export async function scrapeWithFetch(url: URL): Promise<PageResearch> {
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; PloyAdsResearch/1.0)" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`The site returned ${res.status}`);
  const html = (await res.text()).slice(0, 3_000_000);
  const base = res.url;

  const metaContent = (key: string) =>
    html.match(
      new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']+)`, "i"),
    )?.[1] ??
    html.match(
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${key}["']`, "i"),
    )?.[1];

  const ldLogo =
    html.match(/"logo"\s*:\s*"([^"]+)"/)?.[1] ??
    html.match(/"logo"\s*:\s*\{[^}]*"url"\s*:\s*"([^"]+)"/)?.[1];
  const logoImg = html.match(/<img[^>]+src=["']([^"']*logo[^"']*)["']/i)?.[1];
  const touchIcon = html.match(/<link[^>]+rel=["']apple-touch-icon["'][^>]*href=["']([^"']+)/i)?.[1];

  const logoCandidates = unique([
    absoluteUrl(ldLogo, base),
    absoluteUrl(logoImg, base),
    absoluteUrl(metaContent("og:image"), base),
    absoluteUrl(touchIcon, base),
  ]);

  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
  const themeColor = toHex(metaContent("theme-color"));
  const cssColors = mostFrequent(
    [...styles.matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => m[0].toUpperCase()),
    5,
  );
  const fontFamilies = mostFrequent(
    [...styles.matchAll(/font-family\s*:\s*([^;}{]+)/gi)]
      .map((m) => cleanFontFamily(m[1]))
      .filter((f): f is string => Boolean(f)),
    2,
  );

  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  const content = body
    .replace(/<(script|style|svg|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20_000);

  const links = unique(
    [...html.matchAll(/<a[^>]+href=["']([^"'#]+)/gi)].map((m) => absoluteUrl(m[1], base)),
  );

  return {
    source: "html",
    title: html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim(),
    description: metaContent("og:description") ?? metaContent("description"),
    siteName: metaContent("og:site_name"),
    logo: logoCandidates[0],
    logoCandidates,
    colors: unique([themeColor, ...cssColors]).map((hex, i) => ({
      hex,
      role: i === 0 && themeColor ? "Theme" : "Accent",
    })),
    fonts: fontFamilies.map((family, i) => ({ family, role: i === 0 ? "Primary" : "Secondary" })),
    content,
    links,
  };
}

const PRODUCT_PATH = /\/(products?|p|item|items|shop)\/[^/?#]+/i;
const MAX_SITE_PRODUCTS = 6;

/**
 * Product discovery for non-Shopify sites: product-looking links from the
 * homepage (topped up from Firecrawl's site map), each read with Firecrawl's
 * `product` format so we get real titles, prices and images.
 */
export async function findSiteProducts(
  fc: Firecrawl,
  url: URL,
  homepageLinks: string[],
): Promise<Product[]> {
  const host = url.hostname.replace(/^www\./, "");
  const isProductLink = (link: string) => {
    try {
      const u = new URL(link);
      return u.hostname.replace(/^www\./, "") === host && PRODUCT_PATH.test(u.pathname);
    } catch {
      return false;
    }
  };

  let candidates = unique(homepageLinks.filter(isProductLink));

  // URL patterns vary by platform (/eyeglasses/women/durand). When they don't
  // find enough, ask Firecrawl to read the products featured on the homepage.
  let featured: FeaturedProduct[] = [];
  if (candidates.length < 3) {
    featured = await extractFeaturedProducts(fc, url);
    candidates = unique([
      ...candidates,
      ...featured
        .map((f) => absoluteUrl(f.url, url.href))
        .filter((u): u is string => u !== undefined && isSameSite(u, host)),
    ]);
  }

  const targets = candidates.slice(0, MAX_SITE_PRODUCTS);
  const reads = await Promise.allSettled(
    targets.map((link) => fc.scrape(link, { formats: ["product"], maxAge: DAY_MS, timeout: 45_000 })),
  );

  const products = reads.flatMap((read, i): Product[] => {
    if (read.status !== "fulfilled" || !read.value.product) return [];
    const p = read.value.product;
    const link = targets[i];
    const images = unique(
      p.variants.flatMap((v) => (v.images ?? []).map((img) => absoluteUrl(img.url, link))),
    );
    if (!p.title || images.length === 0) return [];
    return [
      {
        id: link,
        title: p.title,
        url: p.url || link,
        price: formatPrice(p.variants[0]?.price),
        productType: p.category,
        description: p.description?.slice(0, 600),
        images: images.slice(0, 8),
      },
    ];
  });

  // Featured items whose pages couldn't be read still count if the homepage
  // showed a real product photo for them.
  const seen = new Set(products.map((p) => p.id));
  for (const f of featured) {
    const link = absoluteUrl(f.url, url.href);
    const image = absoluteUrl(f.imageUrl, url.href);
    if (!link || !image || seen.has(link) || products.length >= MAX_SITE_PRODUCTS) continue;
    seen.add(link);
    products.push({ id: link, title: f.name, url: link, price: f.price, images: [image] });
  }
  return products;
}

/** "$95.00" when the currency is known; sites' own `formatted` strings often drop the symbol. */
function formatPrice(price?: { amount: number; currency?: string; formatted?: string }) {
  if (!price) return undefined;
  if (price.currency) {
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency: price.currency }).format(price.amount);
    } catch {}
  }
  return price.formatted ?? String(price.amount);
}

type FeaturedProduct = { name: string; url?: string; imageUrl?: string; price?: string };

const FEATURED_PRODUCTS_SCHEMA = {
  type: "object",
  properties: {
    products: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          url: { type: "string", description: "Link to the product's own page" },
          imageUrl: { type: "string", description: "URL of the product photo shown on the page" },
          price: { type: "string" },
        },
        required: ["name"],
      },
    },
  },
  required: ["products"],
};

async function extractFeaturedProducts(fc: Firecrawl, url: URL): Promise<FeaturedProduct[]> {
  try {
    const doc = await fc.scrape(url.href, {
      formats: [
        {
          type: "json",
          prompt:
            "List up to 8 individual products for sale that this page features (not categories or collections), with each product's own page link, photo URL and price.",
          schema: FEATURED_PRODUCTS_SCHEMA,
        },
      ],
      maxAge: DAY_MS,
      timeout: 60_000,
    });
    const json = doc.json as { products?: FeaturedProduct[] } | undefined;
    return (json?.products ?? []).filter((p) => typeof p?.name === "string" && p.name.trim());
  } catch (error) {
    console.error("[research] featured product extraction failed", error);
    return [];
  }
}

function isSameSite(link: string, host: string): boolean {
  try {
    return new URL(link).hostname.replace(/^www\./, "") === host;
  } catch {
    return false;
  }
}

// --- branding helpers -------------------------------------------------------

const COLOR_ROLES: Record<string, string> = {
  primary: "Primary",
  secondary: "Secondary",
  accent: "Accent",
  background: "Background",
  textPrimary: "Text",
  textSecondary: "Muted text",
  link: "Link",
};

function colorsFromBranding(branding?: BrandingProfile): BrandColor[] {
  const seen = new Set<string>();
  const colors: BrandColor[] = [];
  for (const [key, role] of Object.entries(COLOR_ROLES)) {
    const hex = toHex(branding?.colors?.[key]);
    if (hex && !seen.has(hex)) {
      seen.add(hex);
      colors.push({ hex, role });
    }
  }
  return colors.slice(0, 6);
}

function fontsFromBranding(branding?: BrandingProfile): BrandFont[] {
  const families = branding?.typography?.fontFamilies;
  const entries: [string | undefined, string][] = [
    [families?.heading, "Headings"],
    [families?.primary, "Body"],
    ...(branding?.fonts ?? []).map((f): [string, string] => [f.family, "Also used"]),
  ];

  const seen = new Set<string>();
  const fonts: BrandFont[] = [];
  for (const [raw, role] of entries) {
    const family = cleanFontFamily(raw);
    if (family && !seen.has(family.toLowerCase())) {
      seen.add(family.toLowerCase());
      fonts.push({ family, role });
    }
  }
  return fonts.slice(0, 3);
}

function styleHintsFromBranding(branding?: BrandingProfile): string | undefined {
  if (!branding) return undefined;
  const hints = [
    branding.personality &&
      `personality: ${branding.personality.tone}, ${branding.personality.energy} energy, audience "${branding.personality.targetAudience}"`,
    branding.tone?.voice && `voice: ${branding.tone.voice}`,
    branding.colorScheme && `color scheme: ${branding.colorScheme}`,
  ].filter(Boolean);
  return hints.length ? hints.join("; ") : undefined;
}

const GENERIC_FONTS = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "-apple-system",
  "blinkmacsystemfont",
  "inherit",
  "initial",
  "unset",
  "var",
]);

/** First real family in a CSS font stack: `"Exo2", sans-serif` → `Exo2`. */
export function cleanFontFamily(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  for (const part of stack.split(",")) {
    const family = part
      .replace(/["']|!important/g, "")
      .replace(/\s+Fallback$/i, "")
      .trim();
    const lower = family.toLowerCase();
    if (!family || GENERIC_FONTS.has(lower) || lower.startsWith("var(")) continue;
    if (/icon|awesome|symbol|emoji/i.test(family)) continue;
    return family;
  }
  return undefined;
}

/** Normalizes #rgb, #rrggbb(aa) and rgb()/rgba() to uppercase #RRGGBB. */
export function toHex(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();

  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex.slice(0, 6);
    return `#${full.toUpperCase()}`;
  }

  const rgb = v.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
  if (rgb) {
    const alpha = rgb[4] ? parseFloat(rgb[4]) / (rgb[4].endsWith("%") ? 100 : 1) : 1;
    if (alpha < 0.5) return undefined;
    return `#${rgb
      .slice(1, 4)
      .map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()}`;
  }
  return undefined;
}

function str(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function unique<T>(values: (T | undefined | null)[]): T[] {
  return [...new Set(values.filter((v): v is T => v != null))];
}

function mostFrequent(values: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([v]) => v);
}
