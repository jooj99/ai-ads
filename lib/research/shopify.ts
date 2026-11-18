import type { Product } from "./types";

/**
 * Shopify stores expose their catalog as public JSON (`/products.json`), which
 * is faster, cheaper and more exact than scraping product pages: real titles,
 * prices, tags and the store's own product photography on Shopify's CDN.
 */

const HEADERS = {
  accept: "application/json",
  "user-agent": "Mozilla/5.0 (compatible; PloyAdsResearch/1.0)",
};
const PAGE_SIZE = 250; // Shopify's maximum
const MAX_PAGES = 2; // cap large catalogs at 500 products

export type ShopifyStore = {
  /** Canonical origin after redirects, e.g. https://www.loopycases.com */
  origin: string;
  name?: string;
  currency?: string;
};

/** Returns the store if `/meta.json` answers like Shopify, otherwise null. */
export async function detectShopify(url: URL): Promise<ShopifyStore | null> {
  try {
    const res = await fetch(new URL("/meta.json", url), {
      headers: HEADERS,
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok || !res.headers.get("content-type")?.includes("json")) return null;

    const meta = (await res.json()) as Record<string, unknown>;
    const looksShopify =
      typeof meta.id === "number" &&
      (typeof meta.domain === "string" || typeof meta.myshopify_domain === "string");
    if (!looksShopify) return null;

    return {
      origin: new URL(res.url).origin,
      name: typeof meta.name === "string" ? meta.name : undefined,
      currency: typeof meta.currency === "string" ? meta.currency : undefined,
    };
  } catch {
    return null;
  }
}

type RawProduct = {
  id: number;
  title: string;
  handle: string;
  body_html: string | null;
  product_type: string;
  tags: string[] | string;
  variants: { price: string; available?: boolean }[];
  images: { src: string }[];
};

/** Loads the store's catalog, skipping products without photos or stock. */
export async function fetchShopifyCatalog(
  store: ShopifyStore,
): Promise<{ products: Product[]; total: number }> {
  const raw: RawProduct[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(
      `${store.origin}/products.json?limit=${PAGE_SIZE}&page=${page}`,
      { headers: HEADERS, signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) {
      if (page === 1) throw new Error(`Shopify catalog returned ${res.status}`);
      break;
    }
    const { products } = (await res.json()) as { products: RawProduct[] };
    raw.push(...products);
    if (products.length < PAGE_SIZE) break;
  }

  const price = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: store.currency ?? "USD",
  });

  const products = raw
    .filter((p) => p.images.length > 0)
    .filter((p) => p.variants.length === 0 || p.variants.some((v) => v.available !== false))
    .map((p): Product => {
      const prices = p.variants.map((v) => Number(v.price)).filter(Number.isFinite);
      return {
        id: String(p.id),
        title: p.title,
        url: `${store.origin}/products/${p.handle}`,
        price: prices.length ? price.format(Math.min(...prices)) : undefined,
        productType: p.product_type || undefined,
        tags: (Array.isArray(p.tags) ? p.tags : p.tags.split(","))
          .map((t) => t.trim())
          .filter(Boolean),
        description: htmlToText(p.body_html).slice(0, 600) || undefined,
        images: p.images.slice(0, 8).map((i) => i.src),
      };
    });

  return { products, total: raw.length };
}

function htmlToText(html: string | null): string {
  if (!html) return "";
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
