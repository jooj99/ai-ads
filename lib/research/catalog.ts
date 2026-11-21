import type Firecrawl from "@mendable/firecrawl-js";

import { fetchHtml, imagesFromHtml, isImageFragment, mapLimit, type LayoutLink } from "./html-signals";
import { classifyLinks, type CandidateLink, type LinkPicks, type PickedLink } from "./links";
import { DAY_MS, withRateLimitRetry, type PageResearch } from "./page";
import { MAX_PRODUCT_TYPES, type Offering, type Product } from "./types";
import { absoluteUrl, isPublicHttpUrl } from "./url";
import { publicFetch } from "@/lib/research/public-fetch";

/**
 * Catalog discovery for sites without Shopify's /products.json. A small model
 * first sorts the site's links into offering pages, offering indexes and
 * audience pages (`pickSiteLinks`); goods and services are then read from
 * those pages. When that call fails, the keyword rules below choose instead.
 * Either way each item keeps the site's own photos.
 */

const PRODUCT_PATH = /\/(products?|p|item|items|shop)\/[^/?#]+/i;
/** Pages that are never a category, product or service. */
const UTILITY_PATH =
  /\/(first-time[\w-]*|new-guest[\w-]*|[\w-]*what-to-expect[\w-]*|[\w-]*-advice|[\w-]*-prep|[\w-]*aftercare|guides?|tips|about|our-story|blog|journal|news|help|support|faq|contact|account|login|log-in|sign|register|cart|bag|checkout|search|careers|jobs|store-locator|stores|locations|press|privacy|terms|policy|policies|legal|returns|shipping|track|rewards|refer|affiliate|wholesale|gift-?cards?|accessibility|sitemap)(\/|$)/i;
const SERVICE_WORDS =
  /service|treatment|therap|class|lesson|course|program|package|membership|plans?\b|pricing|appointment|consult|repair|clean|install|session|coaching|facial|massage|wax|hair|nail|dental|exam|care\b|solution|what-we-do|what we do|offering|menu/i;
const SERVICE_INDEX = /services|treatments|what we do|what-we-do|our menu|pricing|offerings/i;

/** Firecrawl calls per research run stay under the free plan's ~15/minute. */
const MAX_PAGE_READS = 8;
/**
 * Offering pages read as plain HTML once the Firecrawl reads are used up: free
 * and not rate limited, so a big menu (every Mac, every iPhone) still gets in.
 * A catalog tops out around MAX_PAGE_READS + this.
 */
const MAX_HTML_READS = 48;
/** Plain HTML reads at a time, to go easy on the store's server. */
const HTML_READ_CONCURRENCY = 6;
/** Links offered to the link picker: labeled navbar/footer links first, then page links. */
const MAX_PICKER_LINKS = 150;

// --- link picking -----------------------------------------------------------

/**
 * Asks the small model which of the homepage's links are offerings, offering
 * indexes or audience pages. Returns null when the call fails or finds no
 * offerings or indexes, so callers fall back to the keyword rules.
 */
export async function pickSiteLinks({
  url,
  page,
  offering,
  guidance,
}: {
  url: URL;
  page: PageResearch;
  offering: Offering;
  guidance?: string;
}): Promise<LinkPicks | null> {
  const candidates = pickerCandidates(url, page);
  if (candidates.length === 0) return null;
  try {
    const picks = await classifyLinks({
      domain: bareHost(url.href),
      offering,
      navigation: page.navigation,
      candidates,
      guidance,
    });
    return picks.offerings.length > 0 || picks.indexes.length > 0 ? picks : null;
  } catch (error) {
    console.error("[research] link picking failed", error);
    return null;
  }
}

/** Same-site pages other than the homepage and obvious utility pages, without #fragments. */
export function pickerCandidates(url: URL, page: PageResearch): CandidateLink[] {
  const host = bareHost(url.href);
  const home = url.pathname.replace(/\/$/, "");
  const seen = new Set<string>();
  const out: CandidateLink[] = [];
  const add = (raw: string, text: string, area: CandidateLink["area"]) => {
    if (!isSameSite(raw, host)) return;
    const u = new URL(raw);
    u.hash = "";
    const path = u.pathname.replace(/\/$/, "");
    if (path === home || UTILITY_PATH.test(u.pathname) || FILE_PATH.test(u.pathname)) return;
    if (seen.has(u.href)) return;
    seen.add(u.href);
    out.push({ url: u.href, text, area });
  };
  for (const l of page.layoutLinks) add(l.url, l.text, l.area);
  for (const l of page.links) add(l, "", "page");
  return out.slice(0, MAX_PICKER_LINKS);
}

const FILE_PATH = /\.(pdf|jpe?g|png|gif|webp|svg|zip|xml|json|txt)$/i;

function toLayoutLink(link: PickedLink): LayoutLink {
  return { text: link.text, url: link.url, area: "nav" };
}

/**
 * The picker's offering URLs, taking turns across its groups (the site's
 * product lines) so the page-read cap covers every line before a second page
 * of any: one Mac, one iPad, one iPhone… rather than the first 8 in menu
 * order (Vision Pro and seven Macs on apple.com). Groups keep the order they
 * first appear in; ungrouped links share one turn per round, after the groups.
 */
export function spreadAcrossGroups(links: PickedLink[]): string[] {
  const groups = new Map<string, string[]>();
  const ungrouped: string[] = [];
  for (const l of links) {
    const group = l.group?.trim().toLowerCase();
    if (!group) ungrouped.push(l.url);
    else groups.set(group, [...(groups.get(group) ?? []), l.url]);
  }
  const queues = [...groups.values(), ...(ungrouped.length ? [ungrouped] : [])];
  const out: string[] = [];
  for (let round = 0; out.length < links.length; round++) {
    let added = false;
    for (const queue of queues) {
      if (round < queue.length) {
        out.push(queue[round]);
        added = true;
      }
    }
    if (!added) break;
  }
  return unique(out);
}

/** True when the picker named at least one offering or index to read. */
function hasPicks(picks: LinkPicks | null | undefined): picks is LinkPicks {
  return Boolean(picks && (picks.offerings.length > 0 || picks.indexes.length > 0));
}

// --- goods ------------------------------------------------------------------

export async function findSiteProducts(
  fc: Firecrawl,
  url: URL,
  page: PageResearch,
  picks: LinkPicks | null = null,
): Promise<Product[]> {
  const host = bareHost(url.href);
  const siteLinks = unique([...page.links, ...page.layoutLinks.map((l) => l.url)]).filter((u) =>
    isSameSite(u, host),
  );
  const picked = hasPicks(picks) ? picks : null;

  // Offering pages the picker found are products in their own right (a
  // software module, a product line), not categories to dig under.
  const offeringPages = picked ? spreadAcrossGroups(picked.offerings) : [];
  const typeOf = new Map<string, string>(
    (picked?.offerings ?? []).flatMap((l): [string, string][] => {
      const type = l.group ?? cleanLinkText(l.text);
      return type ? [[l.url, type]] : [];
    }),
  );

  // Categories (/eyeglasses, /sunglasses, …) give the full range of product
  // types; read one product page under each to cover them all. The picker's
  // indexes when it ran, else navbar links that look like categories.
  const categories = picked ? picked.indexes.map(toLayoutLink) : categoryLinks(page.layoutLinks, host);
  let mapped: string[] = [];
  if (categories.length > 0) {
    const map = await withRateLimitRetry(() => fc.map(url.origin, { limit: 1000 })).catch(
      () => null,
    );
    mapped = (map?.links ?? []).map((l) => l.url).filter((u) => isSameSite(u, host));
  }
  const pool = unique([...mapped, ...siteLinks]);
  const perCategory: string[] = [];
  for (const category of categories) {
    const product = deepestUnder(category.url, pool);
    if (product && !perCategory.includes(product) && !offeringPages.includes(product)) {
      perCategory.push(product);
      typeOf.set(product, category.text);
    }
  }

  const direct = siteLinks.filter((u) => PRODUCT_PATH.test(new URL(u).pathname));
  let candidates = unique([...offeringPages, ...perCategory, ...direct]);

  // Still thin: ask Firecrawl for the products the homepage features. Not when
  // the picker found offering pages: a homepage's feature lists (security,
  // integrations) would then be mistaken for products.
  let featured: ExtractedItem[] = [];
  if (candidates.length < 3 && offeringPages.length === 0) {
    featured = await extractItems(fc, url.href, "products");
    candidates = unique([...candidates, ...sameSiteUrls(featured, url.href, host)]);
  }

  const targets = candidates.slice(0, MAX_PAGE_READS);
  const reads = await Promise.allSettled(
    targets.map((link) =>
      withRateLimitRetry(() =>
        fc.scrape(link, {
          // Offering pages may not be shop listings (a software module has no
          // variants), so read their photos too in case the product read is empty.
          // (Read as rendered HTML: Firecrawl's own `images` list splits CDN URLs
          // on commas, so photos come from our srcset-aware parser instead.)
          formats: offeringPages.includes(link) ? ["product", "rawHtml"] : ["product"],
          maxAge: DAY_MS,
          timeout: 45_000,
        }),
      ),
    ),
  );

  logFailedReads(reads, targets);
  const products = reads.flatMap((read, i): Product[] => {
    if (read.status !== "fulfilled") return [];
    const doc = read.value;
    const p = doc.product;
    const link = targets[i];
    const images = unique(
      (p?.variants ?? []).flatMap((v) => (v.images ?? []).map((img) => absoluteUrl(img.url, link))),
    ).filter((src) => !isImageFragment(src, link));
    if (p?.title && images.length > 0) {
      return [
        {
          id: link,
          title: p.title,
          url: p.url || link,
          price: formatPrice(p.variants[0]?.price),
          productType: typeOf.get(link) ?? p.category,
          description: p.description?.slice(0, 600),
          images: images.slice(0, 8),
        },
      ];
    }

    // An offering page that isn't a shop listing: keep it, described by its
    // own title and meta description, with the page's photos.
    if (!offeringPages.includes(link)) return [];
    const meta = doc.metadata ?? {};
    const title = p?.title || cleanTitle(meta.ogTitle ?? meta.title);
    if (!title) return [];
    return [
      {
        id: link,
        title,
        url: link,
        price: formatPrice(p?.variants[0]?.price),
        productType: typeOf.get(link) ?? p?.category,
        description: (p?.description ?? meta.description ?? meta.ogDescription)?.slice(0, 600),
        images: rankPagePhotos(
          unique([...images, ...(doc.rawHtml ? imagesFromHtml(doc.rawHtml, link) : [])]),
          { title, ogImage: absoluteUrl(meta.ogImage, link), retail: new Set() },
        ),
      },
    ];
  });

  // The picker's offering pages past the Firecrawl cap: read as plain HTML
  // (title, JSON-LD, share image and page photos), free and not rate limited.
  // Pages that only render with JavaScript come back empty and are skipped.
  const overflow = offeringPages.filter((u) => !targets.includes(u)).slice(0, MAX_HTML_READS);
  const htmlReads = await mapLimit(overflow, HTML_READ_CONCURRENCY, (link) =>
    readProductPage(null, new URL(link)).catch(() => null),
  );
  const fromHtml = htmlReads.flatMap((p, i): Product[] =>
    p ? [{ ...p, id: overflow[i], productType: typeOf.get(overflow[i]) ?? p.productType }] : [],
  );

  return withoutSiteChrome(
    [...products, ...fromHtml, ...itemsFromExtraction(featured, url.href, products)],
    notItemPhotos(page),
  );
}

/** Navbar links that look like top-level product categories. */
function categoryLinks(links: LayoutLink[], host: string): LayoutLink[] {
  return links.filter((l) => {
    if (l.area !== "nav" || !isSameSite(l.url, host)) return false;
    const path = new URL(l.url).pathname.replace(/\/$/, "");
    const depth = path.split("/").filter(Boolean).length;
    return depth >= 1 && depth <= 2 && !UTILITY_PATH.test(path) && !PRODUCT_PATH.test(path);
  });
}

/** The deepest page under a category path, which is most likely a product. */
function deepestUnder(categoryUrl: string, pool: string[]): string | undefined {
  const base = new URL(categoryUrl).pathname.replace(/\/$/, "");
  const depth = (u: string) => new URL(u).pathname.split("/").filter(Boolean).length;
  const baseDepth = depth(categoryUrl);
  return pool
    .filter((u) => {
      const path = new URL(u).pathname;
      return path.startsWith(`${base}/`) && depth(u) > baseDepth && !UTILITY_PATH.test(path) && !new URL(u).search;
    })
    .sort((a, b) => depth(b) - depth(a))[0];
}

// --- services ---------------------------------------------------------------

/**
 * Service businesses rarely have product pages. Find the service pages
 * (navbar, footer, a services index), read each for its name, description,
 * price and photos, and return them in the same shape as products so the
 * rest of research treats them identically.
 */
export async function findSiteServices(
  fc: Firecrawl,
  url: URL,
  page: PageResearch,
  /** Photos of the business's retail products, which service pages cross-sell. */
  productImages: string[] = [],
  picks: LinkPicks | null = null,
): Promise<Product[]> {
  const retail = new Set(productImages.map(fileName));
  const host = bareHost(url.href);
  const picked = hasPicks(picks) ? picks : null;

  let serviceLinks: LayoutLink[];
  let index: LayoutLink | undefined;
  const typeOf = new Map<string, string>();
  if (picked) {
    serviceLinks = picked.offerings.map(toLayoutLink);
    index = picked.indexes.map(toLayoutLink)[0];
    for (const l of picked.offerings) {
      const type = l.group ?? cleanLinkText(l.text);
      if (type) typeOf.set(l.url, type);
    }
  } else {
    // Keyword fallback when the picker didn't run or found nothing.
    const labeled: LayoutLink[] = [
      ...page.layoutLinks,
      ...page.links.map((u): LayoutLink => ({ text: "", url: u, area: "nav" })),
    ].filter((l) => isSameSite(l.url, host));
    serviceLinks = labeled.filter((l) => {
      const path = new URL(l.url).pathname;
      return path !== "/" && !UTILITY_PATH.test(path) && (SERVICE_WORDS.test(l.text) || SERVICE_WORDS.test(path));
    });
    index = serviceLinks.find(
      (l) => SERVICE_INDEX.test(l.text) || SERVICE_INDEX.test(new URL(l.url).pathname),
    );
    for (const l of serviceLinks) if (l.text) typeOf.set(l.url, l.text);
  }

  // A services index lists everything; extract from it. Without one, extract
  // from the homepage only when no offering pages were found: otherwise the
  // homepage's feature lists (security, integrations) would pass as services.
  const extractFrom = index?.url ?? (picked && serviceLinks.length > 0 ? undefined : url.href);
  const extracted = extractFrom ? await extractItems(fc, extractFrom, "services") : [];

  const extractedUrls = sameSiteUrls(extracted, url.href, host);
  // The picker's offerings take turns across their groups (as for goods), so
  // the read cap covers every line of services.
  const linkUrls = picked ? spreadAcrossGroups(picked.offerings) : serviceLinks.map((l) => l.url);
  // The picker's offerings are the site's own headline list, so they're read first.
  const targets = unique(picked ? [...linkUrls, ...extractedUrls] : [...extractedUrls, ...linkUrls])
    .filter((u) => u !== index?.url && u !== url.href)
    .slice(0, MAX_PAGE_READS);

  const reads = await Promise.allSettled(
    targets.map((link) =>
      withRateLimitRetry(() =>
        fc.scrape(link, { formats: ["markdown", "rawHtml"], maxAge: DAY_MS, timeout: 45_000 }),
      ),
    ),
  );

  const byUrl = new Map(extracted.map((e) => [absoluteUrl(e.url, url.href), e]));
  logFailedReads(reads, targets);
  const services = reads.flatMap((read, i): Product[] => {
    if (read.status !== "fulfilled") return [];
    const doc = read.value;
    const link = targets[i];
    const meta = doc.metadata ?? {};
    const hint = byUrl.get(link);
    const title = hint?.name ?? cleanTitle(meta.ogTitle ?? meta.title);
    if (!title) return [];
    const images = rankPagePhotos(
      doc.rawHtml ? imagesFromHtml(doc.rawHtml, link) : [],
      {
        title,
        ogImage: absoluteUrl(meta.ogImage, link),
        hinted: absoluteUrl(hint?.imageUrl, link),
        retail,
      },
    );
    return [
      {
        id: link,
        title,
        url: link,
        price: hint?.price ?? doc.markdown?.match(/\$\s?\d[\d,]*(?:\.\d{2})?/)?.[0],
        productType: hint?.category ?? typeOf.get(link),
        description: (hint?.description ?? meta.description ?? firstParagraph(doc.markdown))?.slice(
          0,
          600,
        ),
        images,
      },
    ];
  });

  const found = [...services, ...itemsFromExtraction(extracted, url.href, services)];

  // Service links whose pages weren't read still belong to the full list the
  // model groups into types; they just have no photos, so they're unlikely picks.
  const known = new Set(found.flatMap((f) => [f.url, f.title.toLowerCase()]));
  for (const link of serviceLinks) {
    const title = cleanLinkText(link.text);
    if (!title || known.has(link.url) || known.has(title.toLowerCase()) || link.url === index?.url) {
      continue;
    }
    known.add(link.url);
    known.add(title.toLowerCase());
    found.push({ id: link.url, title, url: link.url, images: [] });
  }
  return withoutSiteChrome(found, notItemPhotos(page));
}

// --- one product from a link ---------------------------------------------------

/**
 * Reads one product (or service) page the user linked to and returns it as a
 * catalog item with the page's own photos, or null if no item with a title
 * and photo could be read. Tries, in order:
 * 1. Shopify's product JSON (`/products/<handle>.json`): exact title, price
 *    and every product photo, free and fast; any Shopify store has it;
 * 2. Firecrawl's product read plus the rendered HTML (ranked page photos
 *    when the page isn't a shop listing);
 * 3. the plain HTML: JSON-LD Product data, then the share image and <img>s.
 * `notPhotos` are file names that are never the item's photo (the site's
 * logo and share image).
 */
export async function readProductPage(
  fc: Firecrawl | null,
  url: URL,
  notPhotos: Set<string> = new Set(),
): Promise<Product | null> {
  const link = url.href;
  // The page's real photos: one copy of each file (sites list the same photo
  // at several sizes), no site chrome or self-described banners.
  const keep = (images: string[]) => {
    const seen = new Set<string>();
    return unique(images.map((src) => absoluteUrl(src, link)))
      .filter((src) => {
        const name = fileName(src);
        if (!isPublicHttpUrl(src) || !isPhoto(src) || isImageFragment(src, link)) return false;
        if (notPhotos.has(name) || DECORATION.test(name) || seen.has(name)) return false;
        seen.add(name);
        return true;
      })
      .slice(0, 8);
  };

  const shop = await shopifyProduct(url).catch(() => null);
  if (shop && keep(shop.images).length) return { ...shop, images: keep(shop.images) };

  if (fc) {
    try {
      const doc = await withRateLimitRetry(() =>
        fc.scrape(link, { formats: ["product", "rawHtml"], maxAge: DAY_MS, timeout: 45_000 }),
      );
      const p = doc.product;
      const meta = doc.metadata ?? {};
      const title = p?.title || cleanTitle(meta.ogTitle ?? meta.title);
      const variantPhotos = (p?.variants ?? []).flatMap((v) => (v.images ?? []).map((img) => img.url));
      // With the store's own product photos in hand, other page photos only
      // count from the same image host (not review widgets or promos elsewhere).
      const photoHosts = new Set(variantPhotos.flatMap((src) => hostOf(absoluteUrl(src, link))));
      const pagePhotos =
        doc.rawHtml && title
          ? rankPagePhotos(keep(imagesFromHtml(doc.rawHtml, link)), {
              title,
              ogImage: absoluteUrl(meta.ogImage, link),
              retail: new Set(),
            }).filter((src) => !photoHosts.size || photoHosts.has(hostOf(src)[0] ?? ""))
          : [];
      const images = keep([...variantPhotos, ...pagePhotos]);
      if (title && images.length) {
        return {
          id: link,
          title: unspace(title),
          url: link,
          price: formatPrice(p?.variants?.[0]?.price),
          productType: p?.category,
          description: (p?.description ?? meta.description ?? meta.ogDescription)?.slice(0, 600),
          images,
        };
      }
    } catch (error) {
      console.error(`[research] reading the linked product page failed: ${link}`, error);
    }
  }

  try {
    const { html, base } = await fetchHtml(url);
    const ld = productFromJsonLd(html);
    const title = ld?.name ?? cleanTitle(metaContent(html, "og:title") ?? html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]);
    if (!title) return null;
    const ogImage = absoluteUrl(metaContent(html, "og:image"), base);
    const images = keep([
      ...(ld?.images ?? []),
      ...rankPagePhotos(imagesFromHtml(html, base), { title, ogImage, retail: new Set() }),
    ]);
    if (!images.length) return null;
    return {
      id: link,
      title: unspace(decodeEntities(title)),
      url: link,
      price: ld?.price,
      description: (ld?.description ?? metaContent(html, "og:description") ?? metaContent(html, "description"))?.slice(0, 600),
      images,
    };
  } catch (error) {
    console.error(`[research] reading the linked page's HTML failed: ${link}`, error);
    return null;
  }
}

function hostOf(src: string | undefined): string[] {
  try {
    return src ? [new URL(src).hostname] : [];
  } catch {
    return [];
  }
}

/** A Shopify product page's JSON (`…/products/<handle>.json`), or null if it isn't one. */
async function shopifyProduct(url: URL): Promise<Product | null> {
  const handle = url.pathname.match(/\/products\/([^/?#.]+)/)?.[1];
  if (!handle) return null;
  const res = await publicFetch(`${url.origin}/products/${handle}.json`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return null;
  const { product } = (await res.json()) as {
    product?: {
      title: string;
      body_html?: string;
      product_type?: string;
      tags?: string | string[];
      images?: { src: string }[];
      variants?: { price?: string }[];
    };
  };
  if (!product?.title) return null;
  const price = product.variants?.[0]?.price;
  return {
    id: url.href,
    title: product.title,
    url: url.href,
    price: price ? `$${price}` : undefined,
    productType: product.product_type || undefined,
    tags: Array.isArray(product.tags) ? product.tags : product.tags?.split(",").map((t) => t.trim()).filter(Boolean),
    description: product.body_html?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 600) || undefined,
    images: (product.images ?? []).map((i) => i.src),
  };
}

/** The first schema.org Product in the page's JSON-LD: name, photos, price, description. */
function productFromJsonLd(html: string): { name?: string; images: string[]; price?: string; description?: string } | null {
  for (const match of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try {
      data = JSON.parse(match[1].trim());
    } catch {
      continue;
    }
    const nodes: unknown[] = [];
    const walk = (n: unknown) => {
      if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === "object") {
        nodes.push(n);
        const graph = (n as { "@graph"?: unknown })["@graph"];
        if (graph) walk(graph);
      }
    };
    walk(data);
    const product = nodes.find((n) => {
      const type = (n as { "@type"?: unknown })["@type"];
      return type === "Product" || (Array.isArray(type) && type.includes("Product"));
    }) as { name?: string; description?: string; image?: unknown; offers?: unknown } | undefined;
    if (!product) continue;
    const images = [product.image]
      .flat(2)
      .map((i) => (typeof i === "string" ? i : (i as { url?: string } | null)?.url))
      .filter((i): i is string => typeof i === "string");
    const offer = [product.offers].flat()[0] as { price?: string | number; priceCurrency?: string } | undefined;
    const price =
      offer?.price !== undefined
        ? formatPrice({ amount: Number(offer.price), currency: offer.priceCurrency, formatted: String(offer.price) })
        : undefined;
    return { name: product.name, images, price, description: product.description };
  }
  return null;
}

/** A <meta property|name="…" content="…"> value. */
function metaContent(html: string, key: string): string | undefined {
  const tag = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, "i"))?.[0];
  const value = tag?.match(/content=["']([^"']*)["']/i)?.[1];
  return value ? decodeEntities(value) : undefined;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

/**
 * After the model picks heroes, some picks may be services whose pages
 * weren't read (only their nav links were). Read those pages now so every
 * pick gets the site's own photos when the site has any.
 */
export async function photosForPicks(
  fc: Firecrawl,
  picks: { url: string; title: string }[],
  productImages: string[] = [],
  /** File names that can't be a pick's photo: share image, logo, other items' photos. */
  notPhotos: Set<string> = new Set(),
): Promise<Map<string, string[]>> {
  const retail = new Set(productImages.map(fileName));
  // Plain HTML first: it doesn't count against Firecrawl's per-minute limit,
  // which the catalog step has usually just used up. Firecrawl only for
  // sites that block plain fetches.
  const reads = await Promise.allSettled(
    picks.map(async ({ url }) => {
      try {
        const { html, base } = await fetchHtml(new URL(url));
        const images = imagesFromHtml(html, base); // share image first, then <img>s
        if (images.length) return { images, ogImage: images[0] };
      } catch {}
      const doc = await withRateLimitRetry(() =>
        fc.scrape(url, { formats: ["rawHtml"], maxAge: DAY_MS, timeout: 45_000 }),
      );
      return {
        images: doc.rawHtml ? imagesFromHtml(doc.rawHtml, url) : [],
        ogImage: doc.metadata?.ogImage,
      };
    }),
  );
  logFailedReads(reads, picks.map((p) => p.url));
  const found = new Map<string, string[]>();
  reads.forEach((read, i) => {
    if (read.status !== "fulfilled") return;
    const { url, title } = picks[i];
    const images = rankPagePhotos(
      unique(read.value.images.map((src) => absoluteUrl(src, url))),
      { title, ogImage: absoluteUrl(read.value.ogImage, url), retail },
    ).filter((src) => !notPhotos.has(fileName(src)));
    found.set(url, images);
  });
  // A picture that turns up for two or more picks is the site's, not theirs.
  const seenIn = new Map<string, number>();
  for (const images of found.values()) {
    for (const name of new Set(images.map(fileName))) seenIn.set(name, (seenIn.get(name) ?? 0) + 1);
  }
  const photos = new Map<string, string[]>();
  for (const [url, images] of found) {
    const own = images.filter((src) => (seenIn.get(fileName(src)) ?? 0) < 2);
    if (own.length) photos.set(url, own);
  }
  return photos;
}

const TITLE_STOPWORDS = new Set(["and", "the", "for", "with", "our", "your", "service", "services"]);

/**
 * Service pages mix the service's own photos with cross-sold products and
 * decoration. Rank: drop retail product photos, then prefer files named after
 * the service ("brow-shape.png" for "Eyebrow Waxing") and the page's share
 * image, then page order.
 */
function rankPagePhotos(
  pageImages: string[],
  {
    title,
    ogImage,
    hinted,
    retail,
  }: { title: string; ogImage?: string; hinted?: string; retail: Set<string> },
): string[] {
  const words = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !TITLE_STOPWORDS.has(w));
  const all = unique([ogImage, hinted, ...pageImages]).filter(
    (src) => isPhoto(src) && !retail.has(fileName(src)),
  );
  const score = (src: string, index: number) => {
    const parts = fileName(src).split(/[^a-z0-9]+/).filter((p) => p.length >= 3);
    const named = parts.some((p) => words.some((w) => w.includes(p) || p.includes(w)));
    return (
      (named ? 3 : 0) +
      (src === ogImage ? 2 : 0) +
      (src === hinted ? 1 : 0) -
      (/product/i.test(src) ? 2 : 0) -
      // Sitewide decoration that names itself, e.g. adidas's
      // "bwp_adidas_content_slot_navigation" Buy-with-Prime banner.
      (DECORATION.test(fileName(src)) ? 5 : 0) -
      index * 0.01
    );
  };
  return all
    .map((src, i) => ({ src, s: score(src, i) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.src)
    .slice(0, 6);
}

/** "…/files/brow-shape-long-oval.png?v=1&width=550" → "brow-shape-long-oval.png". */
function fileName(src: string): string {
  return (src.split("?")[0].split("/").pop() ?? "").toLowerCase();
}

// --- shared -----------------------------------------------------------------

type ExtractedItem = {
  name: string;
  url?: string;
  imageUrl?: string;
  price?: string;
  description?: string;
  category?: string;
};

const ITEMS_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          url: { type: "string", description: "Link to the item's own page, if it has one" },
          imageUrl: { type: "string", description: "URL of the photo shown for this item" },
          price: { type: "string" },
          description: { type: "string", description: "One sentence from the page" },
          category: { type: "string", description: "The group it belongs to, e.g. 'Sunglasses' or 'Facials'" },
        },
        required: ["name"],
      },
    },
  },
  required: ["items"],
};

const EXTRACT_PROMPTS = {
  products:
    "List up to 12 individual products for sale that this page features (not categories or collections), each with its own page link, photo URL, price and category.",
  services: `List every service this business offers on this page (up to ${MAX_PRODUCT_TYPES * 2}), each with its own page link if any, the photo shown for it, price if listed, a one-sentence description and its category.`,
};

async function extractItems(
  fc: Firecrawl,
  pageUrl: string,
  kind: keyof typeof EXTRACT_PROMPTS,
): Promise<ExtractedItem[]> {
  try {
    const doc = await withRateLimitRetry(() =>
      fc.scrape(pageUrl, {
        formats: [{ type: "json", prompt: EXTRACT_PROMPTS[kind], schema: ITEMS_SCHEMA }],
        maxAge: DAY_MS,
        timeout: 60_000,
      }),
    );
    const json = doc.json as { items?: ExtractedItem[] } | undefined;
    return (json?.items ?? []).filter((i) => typeof i?.name === "string" && i.name.trim());
  } catch (error) {
    console.error(`[research] ${kind} extraction failed`, error);
    return [];
  }
}

function logFailedReads(reads: PromiseSettledResult<unknown>[], targets: string[]) {
  reads.forEach((read, i) => {
    if (read.status === "rejected") {
      console.error(`[research] page read failed: ${targets[i]}`, read.reason?.message ?? read.reason);
    }
  });
}

/** Nav labels carry badges: "Brazilian Waxing popular" → "Brazilian Waxing". */
/** Sites sometimes letter-space a name in markup: "P l o y M C P" → "PloyMCP". */
function unspace(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length >= 3 && parts.every((p) => p.length === 1) ? parts.join("") : name;
}

function cleanLinkText(text: string): string {
  return unspace(
    text
      .replace(/\s+(popular|new|sale|hot|best ?seller)$/i, "")
      .replace(/&amp;/g, "&")
      .trim(),
  );
}

/** Extracted items whose pages weren't read still count, with the photo the page showed. */
function itemsFromExtraction(items: ExtractedItem[], base: string, existing: Product[]): Product[] {
  const seen = new Set(existing.map((p) => p.id));
  const titles = new Set(existing.map((p) => p.title.toLowerCase()));
  return items.flatMap((item): Product[] => {
    const link = absoluteUrl(item.url, base) ?? `${base}#${encodeURIComponent(item.name)}`;
    if (seen.has(link) || titles.has(item.name.toLowerCase())) return [];
    seen.add(link);
    const image = absoluteUrl(item.imageUrl, base);
    return [
      {
        id: link,
        title: unspace(item.name),
        url: absoluteUrl(item.url, base) ?? base,
        price: item.price,
        productType: item.category,
        description: item.description,
        images: image && isPhoto(image) ? [image] : [],
      },
    ];
  });
}

function sameSiteUrls(items: ExtractedItem[], base: string, host: string): string[] {
  return items
    .map((i) => absoluteUrl(i.url, base))
    .filter((u): u is string => u !== undefined && isSameSite(u, host));
}

const DECORATION = /banner|promo|navigation|content[_-]?slot|(?:^|[_-])nav[_-]|^bwp[_-]|badge/;

/**
 * Site chrome: an image on two or more different item pages (a nav promo
 * like adidas's "Buy with Prime" banner, a site-wide share image, a stock
 * studio photo) isn't any one item's photo, so it's dropped. An item left
 * with no photo of its own shows none rather than a repeated picture: not
 * everything a business sells (a plan, an integration) has a photo.
 */
function withoutSiteChrome(items: Product[], notPhotos: Set<string>): Product[] {
  const pagesWith = new Map<string, number>();
  for (const item of items) {
    for (const name of new Set(item.images.map(fileName))) {
      pagesWith.set(name, (pagesWith.get(name) ?? 0) + 1);
    }
  }
  const isItemPhoto = (src: string) =>
    (pagesWith.get(fileName(src)) ?? 0) < 2 && !notPhotos.has(fileName(src));
  return items.map((item) => ({ ...item, images: item.images.filter(isItemPhoto) }));
}

/**
 * Pictures that are never one item's photo: the homepage's share image (sites
 * fall back to it as every page's og:image) and the logo. Compared by file
 * name, since CDNs serve the same file under different sizes.
 */
/** What a hero pick's late-fetched photos must not be: see notItemPhotos, plus other items' photos. */
export function pickPhotoExclusions(
  page: PageResearch | null,
  otherItems: { images: string[] }[],
): Set<string> {
  const excluded = page ? notItemPhotos(page) : new Set<string>();
  for (const item of otherItems) for (const src of item.images) excluded.add(fileName(src));
  return excluded;
}

/**
 * The shared-photo rule applied to a whole merged catalog (items from several
 * research runs or pages): a picture on two or more items, the share image,
 * the logo or a video is nobody's photo. Returns new photos by item id, for
 * the items whose photos changed.
 */
export function sharedPhotoCleanup(
  items: { id: string; images: string[] }[],
  page: PageResearch | null,
): Map<string, string[]> {
  const cleaned = withoutSiteChrome(items as Product[], page ? notItemPhotos(page) : new Set());
  const changed = new Map<string, string[]>();
  cleaned.forEach((item, i) => {
    const images = item.images.filter(isPhoto);
    if (images.length !== items[i].images.length) changed.set(item.id, images);
  });
  return changed;
}

export function notItemPhotos(page: PageResearch): Set<string> {
  return new Set(
    [page.shareImage, ...page.logoCandidates]
      .filter((src): src is string => Boolean(src) && !src!.startsWith("data:"))
      .map(fileName),
  );
}

/** Drops logos, icons, sprites and tracking pixels; keeps real photography. */
function isPhoto(src: string): boolean {
  const path = src.split("?")[0].toLowerCase();
  if (src.startsWith("data:") || /\.(svg|ico|gif|mp4|webm|mov|m4v)$/.test(path)) return false;
  // Video thumbnails (YouTube embeds) show a video's frame, not the item.
  if (/(^|\/\/)(i\d?\.)?ytimg\.com\/|\/(mq|hq|sd|maxres)?default\.jpg$/.test(path)) return false;
  // Unrendered template placeholders from raw HTML, e.g. {{variantImageURL}}.
  if (/%7b%7b|\{\{|\$\{|%24%7b/i.test(src)) return false;
  // Third-party widgets (survey popups, ad and analytics pixels) aren't product photos.
  if (/qualtrics|doubleclick|googletagmanager|google-analytics|facebook\.com\/tr|cdn-cgi\/challenge|fillout|typeform|hubspot|intercom|calendly|hotjar/.test(src)) return false;
  // Shoppers' review photos (review widgets) aren't the item's own photos.
  if (/turnto|yotpo|bazaarvoice|okendo|judge\.me|stamped\.io|powerreviews|trustpilot|reviews?[-_.]?(?:io|cdn|media)/.test(src)) return false;
  // Thumbnails and color swatches by their requested size (…?wid=32&hei=32).
  const size = (keys: string) => Number(src.match(new RegExp(`[?&](?:${keys})=(\\d+)`, "i"))?.[1] ?? NaN);
  if (size("wid|width|w") <= 120 || size("hei|height|h") <= 120) return false;
  // Analytics beacons dressed as images (Apple's echo.png?pageViewId=…, Adobe's /b/ss/).
  if (/[?&](pageviewid|eventtype|pagename|recordtime)=|no-js|\/b\/ss\/|\/\/[^/]*(metrics|analytics|beacon|telemetry)\./i.test(src)) return false;
  return !/logo|icon|sprite|badge|avatar|pixel|tracking|placeholder|spinner|arrow|payment|flag|emoji|close-?(?:btn|button)|btn-close/.test(path);
}

/** "Facials | Glow Spa" → "Facials"; "ACG. Nike.com" → "ACG". */
function cleanTitle(title: string | undefined): string | undefined {
  const name = title
    ?.split(/\s[|–—-]\s/)[0]
    ?.replace(/[.·]\s*[\w-]+\.(?:com|co|net|org|io|shop|store|us|uk|ca|au)\s*$/i, "")
    .trim();
  return name ? unspace(name) : undefined;
}

function firstParagraph(markdown: string | undefined): string | undefined {
  return markdown
    ?.split(/\n{2,}/)
    .map((p) => p.replace(/[#*_>[\]()!]/g, "").trim())
    .find((p) => p.length > 60);
}

/** "$95.00" when the currency is known; sites' own `formatted` strings often drop the symbol. */
function formatPrice(price?: { amount: number; currency?: string; formatted?: string }) {
  if (!price) return undefined;
  if (price.currency) {
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency: price.currency }).format(
        price.amount,
      );
    } catch {}
  }
  return price.formatted ?? String(price.amount);
}

function bareHost(href: string): string {
  return new URL(href).hostname.replace(/^www\./, "");
}

function isSameSite(link: string, host: string): boolean {
  try {
    return bareHost(link) === host;
  } catch {
    return false;
  }
}

function unique<T>(values: (T | undefined | null)[]): T[] {
  return [...new Set(values.filter((v): v is T => v != null))];
}
