import { findSiteProducts, findSiteServices, photosForPicks, pickSiteLinks } from "./catalog";
import { streamInsights, type Insights } from "./insights";
import { classifyOffering } from "./offering";
import { firecrawlClient, researchPage, type PageResearch } from "./page";
import { detectShopify, fetchShopifyCatalog, type ShopifyStore } from "./shopify";
import {
  MAX_PRODUCT_TYPES,
  STEP_LABELS,
  STEP_ORDER,
  type BrandKit,
  type CatalogItem,
  type Offering,
  type Product,
  type ProductType,
  type ResearchNotice,
  type ResearchStep,
  type SelectedProduct,
  type StepId,
  type StepStatus,
} from "./types";
import { normalizeStoreUrl, ResearchInputError } from "./url";

export type ResearchEmitter = {
  step: (step: ResearchStep) => void;
  kit: (kit: BrandKit) => void;
  notice: (notice: ResearchNotice) => void;
};

/** Partial model output arrives many times a second; send the kit at most this often. */
const KIT_THROTTLE_MS = 150;
/** Hero items shown per product type. */
const MAX_ITEMS_PER_TYPE = 2;
/** Extra page reads for picks without photos (Firecrawl's free plan allows ~15/minute). */
const MAX_PHOTO_FETCHES = 4;

/**
 * URL → brand kit.
 *
 * 1. In parallel: Shopify detection (+ its catalog) and the homepage read
 *    (Firecrawl branding, HTML extractor for gaps, navbar and footer).
 * 2. A quick model call decides whether the business sells goods or services.
 * 3. The catalog follows from that: Shopify's /products.json, one product
 *    page per navbar category, or the site's service pages.
 * 4. One model call reads everything: value prop, audience, voice, and the
 *    catalog grouped into at most 10 types with hero picks for each.
 *
 * Each step degrades on its own, so one failing source never blanks the kit.
 */
export async function runResearch(input: string, emit: ResearchEmitter): Promise<void> {
  const setStep = (id: StepId, status: StepStatus, detail?: string, label?: string) =>
    emit.step({ id, label: label ?? STEP_LABELS[id], status, detail });

  let url: URL;
  try {
    url = normalizeStoreUrl(input);
  } catch (error) {
    const message =
      error instanceof ResearchInputError ? error.message : "That URL couldn't be read.";
    setStep("detect", "error", message);
    emit.notice({ level: "error", message });
    return;
  }

  const kit: BrandKit = {
    sourceUrl: url.href,
    domain: url.hostname.replace(/^www\./, ""),
    logoCandidates: [],
    colors: [],
    fonts: [],
    productTypes: [],
    products: [],
  };
  const sendKit = () => emit.kit(structuredClone(kit));

  for (const id of STEP_ORDER) {
    setStep(id, id === "detect" || id === "brand" ? "running" : "pending");
  }
  sendKit();

  const fc = firecrawlClient();

  // 1a. Platform detection; a Shopify catalog starts loading right away.
  const shopifyPromise: Promise<ShopifyStore | null> = detectShopify(url).then((shopify) => {
    kit.platform = shopify ? "shopify" : "website";
    if (shopify?.name) kit.name ??= shopify.name;
    sendKit();
    setStep("detect", "done", shopify ? "Shopify store detected" : "Website (not a Shopify store)");
    return shopify;
  });
  const shopifyCatalog = shopifyPromise.then((shopify) =>
    shopify
      ? fetchShopifyCatalog(shopify).catch((error) => {
          console.error("[research] shopify catalog failed", error);
          return null;
        })
      : null,
  );

  // 1b. Homepage: brand extractor, HTML extractor for gaps, navbar and footer.
  const pagePromise: Promise<PageResearch | null> = researchPage(fc, url).catch((error) => {
    console.error("[research] page research failed", error);
    return null;
  });

  const brandStep = pagePromise.then((page) => {
    if (!page) {
      setStep("brand", "error", "Couldn't load the site to read its branding");
      return page;
    }
    kit.name ??= page.siteName;
    kit.logo = page.logo;
    kit.logoCandidates = page.logoCandidates;
    kit.colors = page.colors;
    kit.fonts = page.fonts;
    sendKit();

    const logo = page.hasRealLogo
      ? `logo${page.logoVia && page.logoVia !== "brand extractor" ? ` (${page.logoVia})` : ""}`
      : page.logo
        ? "an icon only, no full logo"
        : "no logo";
    const found = `${logo}, ${page.colors.length} colors, ${page.fonts.length} fonts`;
    const degraded = page.source === "html" || !page.hasRealLogo || page.colors.length === 0;
    setStep(
      "brand",
      degraded ? "warning" : "done",
      page.source === "html"
        ? `Found ${found} from the page's HTML (brand extractor unavailable)`
        : page.filled.length
          ? `Found ${found}; filled gaps from the HTML: ${page.filled.join(", ")}`
          : `Found ${found}`,
    );
    return page;
  });

  // 2. Goods or services decides how the catalog is found.
  const offeringStep: Promise<Offering> = (async () => {
    const [page, shopify] = await Promise.all([brandStep, shopifyPromise]);
    setStep("offering", "running");
    try {
      const { offering, reason } = await classifyOffering({
        domain: kit.domain,
        page,
        isShopify: Boolean(shopify),
      });
      kit.offering = offering;
      kit.offeringReason = reason;
      sendKit();
      setStep("offering", "done", `Sells ${offering}: ${reason}`);
      return offering;
    } catch (error) {
      console.error("[research] offering classification failed", error);
      kit.offering = "goods";
      sendKit();
      setStep("offering", "warning", "Couldn't tell; treating it as a goods business");
      return "goods";
    }
  })();

  // 3. The catalog: products or services, always with the site's own photos.
  /** Labels of pages about who the business serves ("Hospitals", "For agencies"). */
  let audiencePages: string[] = [];
  const catalogStep: Promise<Product[]> = (async () => {
    const [offering, page] = await Promise.all([offeringStep, pagePromise]);
    const noun = offering === "services" ? "services" : "products";
    const label = offering === "services" ? "Finding services and their photos" : STEP_LABELS.catalog;
    setStep("catalog", "running", undefined, label);

    try {
      // Goods: a Shopify catalog is the business's own full list. Services:
      // ignore it, since a service business's Shopify shop is usually its
      // retail side (European Wax Center sells serums there, not waxing).
      const shopify = offering === "goods" ? await shopifyCatalog : null;
      if (shopify && shopify.products.length > 0) {
        kit.catalogSize = shopify.total;
        sendKit();
        setStep("catalog", "done", `${shopify.total} ${noun} in the Shopify catalog`, label);
        return shopify.products;
      }

      if (!fc || !page) {
        setStep("catalog", "warning", `Couldn't look for ${noun} on this site`, label);
        return [];
      }

      // A small model picks which of the site's links to read; null means
      // it failed or found nothing, and the keyword rules choose instead.
      setStep("catalog", "running", "Choosing which pages to read", label);
      const picks = await pickSiteLinks({ url, page, offering });
      audiencePages = picks?.audience.map((l) => l.text).filter(Boolean) ?? [];
      setStep(
        "catalog",
        "running",
        picks
          ? `Reading ${picks.offerings.length} ${noun} page${picks.offerings.length === 1 ? "" : "s"}${picks.indexes.length ? ` and ${picks.indexes.length} index page${picks.indexes.length === 1 ? "" : "s"}` : ""}`
          : `Looking for ${noun} pages`,
        label,
      );

      const retail = offering === "services" ? await shopifyCatalog : null;
      const items =
        offering === "services"
          ? await findSiteServices(
              fc,
              url,
              page,
              retail?.products.flatMap((p) => p.images) ?? [],
              picks,
            )
          : await findSiteProducts(fc, url, page, picks);
      kit.catalogSize = items.length;
      sendKit();
      const withPhotos = items.filter((i) => i.images.length > 0).length;
      setStep(
        "catalog",
        items.length ? "done" : "warning",
        items.length
          ? `Found ${items.length} ${noun} (${withPhotos} with photos from the site)`
          : `No ${noun} found; you can add them by link later`,
        label,
      );
      return items;
    } catch (error) {
      console.error("[research] catalog failed", error);
      setStep("catalog", "warning", `Couldn't load the ${noun}`, label);
      return [];
    }
  })();

  const [page, products, offering] = await Promise.all([brandStep, catalogStep, offeringStep]);
  const noun = offering === "services" ? "service" : "product";

  if (!page && products.length === 0) {
    setStep("insights", "error", "Nothing to analyze");
    emit.notice({
      level: "error",
      message: `We couldn't read ${kit.domain}. Check the address, or try again in a minute.`,
    });
    return;
  }

  // 4. One model call: value prop, audience, voice, and up to 10 types with picks.
  setStep("insights", "running");
  const byId = new Map(products.map((p) => [p.id, p]));
  const applyInsights = (insights: DeepPartial<Insights>) => {
    if (insights.brandName) kit.name = insights.brandName;
    if (insights.tagline) kit.tagline = insights.tagline;
    if (insights.valueProposition) kit.valueProposition = insights.valueProposition;
    if (insights.audience) {
      kit.audience = {
        summary: insights.audience.summary,
        segments: strings(insights.audience.segments),
      };
    }
    if (insights.voice) {
      kit.voice = {
        summary: insights.voice.summary,
        traits: strings(insights.voice.traits),
        sampleLine: insights.voice.sampleLine,
      };
    }

    const types: ProductType[] = [];
    const picks: SelectedProduct[] = [];
    const used = new Set<string>();
    for (const type of insights.productTypes ?? []) {
      if (!type?.name || types.length >= MAX_PRODUCT_TYPES) continue;
      const items = (type.items ?? []).flatMap((pick): SelectedProduct[] => {
        const product = pick?.id ? byId.get(pick.id) : undefined;
        if (!product || used.has(product.id)) return []; // only real, unrepeated catalog items
        used.add(product.id);
        return [
          { ...product, reason: pick?.reason, features: strings(pick?.features), typeName: type.name },
        ];
      });
      if (items.length === 0) continue;
      types.push({ name: type.name, summary: type.summary });
      picks.push(...items.slice(0, MAX_ITEMS_PER_TYPE));
    }
    kit.productTypes = types;
    kit.products = picks;
    if (picks.length) kit.productsPickedBy = "ai";
  };

  try {
    const result = streamInsights({ domain: kit.domain, page, products, offering, audiencePages });
    let lastSent = 0;
    for await (const partial of result.partialOutputStream) {
      applyInsights(partial as DeepPartial<Insights>);
      if (Date.now() - lastSent > KIT_THROTTLE_MS) {
        sendKit();
        lastSent = Date.now();
      }
    }
    const final = await result.output;
    applyInsights(final);
    kit.catalog = typedCatalog(products, kit, final.productTypes);
    sendKit();

    // Picks known only from a nav link have no photos yet; read their pages.
    const unphotographed = kit.products
      .filter((p) => p.images.length === 0 && !p.url.includes("#"))
      .slice(0, MAX_PHOTO_FETCHES);
    if (fc && unphotographed.length > 0) {
      setStep("insights", "running", `Getting photos for ${unphotographed.length} picks`);
      const retail = (await shopifyCatalog)?.products.flatMap((p) => p.images) ?? [];
      const photos = await photosForPicks(fc, unphotographed, retail);
      kit.products = kit.products.map((p) =>
        photos.has(p.url) ? { ...p, images: photos.get(p.url)! } : p,
      );
      kit.catalog = kit.catalog?.map((p) =>
        photos.has(p.url) ? { ...p, images: photos.get(p.url)!.slice(0, 4) } : p,
      );
      sendKit();
    }

    const typeCount = kit.productTypes.length;
    setStep(
      "insights",
      kit.products.length || products.length === 0 ? "done" : "warning",
      products.length === 0
        ? `Brand analyzed (no ${noun}s to pick from)`
        : `Grouped ${products.length} ${noun}s into ${typeCount} type${typeCount === 1 ? "" : "s"}; picked ${kit.products.length} to feature`,
    );
  } catch (error) {
    console.error("[research] insights failed", error);
    setStep("insights", "error", "The brand analysis failed");
    if (kit.products.length === 0 && products.length > 0) {
      const fallback = defaultPicks(products);
      kit.productTypes = fallback.types;
      kit.products = fallback.picks;
      kit.productsPickedBy = "default";
    }
    if (products.length > 0) {
      kit.catalog = typedCatalog(products, kit, []);
      sendKit();
    }
    emit.notice({
      level: "warning",
      message:
        products.length > 0
          ? `We pulled the logo, colors, fonts and ${noun}s, but couldn't write the value proposition, audience and voice, so ${noun}s are grouped by their listed type. Try again.`
          : "We pulled the logo, colors and fonts, but couldn't write the value proposition, audience and voice. Try again.",
    });
  }
}

/**
 * Used only when the model is unavailable: group by the catalog's own type
 * field (largest first, at most 10) and pick the item with the most photos.
 */
/**
 * Tags every catalog item with one of the model's types, so the UI can show
 * the whole catalog and filter it: heroes keep their pick's type, then the
 * model's member ids (small catalogs), then the catalog's own listed type
 * mapped through `catalogTypes`; anything left is "Other". Kept slim for the
 * stream: four photos and a short description per item.
 */
function typedCatalog(
  products: Product[],
  kit: BrandKit,
  modelTypes: Insights["productTypes"],
): CatalogItem[] {
  const heroType = new Map(kit.products.map((p) => [p.id, p.typeName]));
  const known = new Set(kit.productTypes.map((t) => t.name));
  const byMember = new Map<string, string>();
  const byListedType = new Map<string, string>();
  for (const type of modelTypes) {
    if (!known.has(type.name)) continue;
    for (const id of type.memberIds) if (!byMember.has(id)) byMember.set(id, type.name);
    for (const listed of type.catalogTypes) {
      const key = listed.trim().toLowerCase();
      if (!byListedType.has(key)) byListedType.set(key, type.name);
    }
  }
  return products.map((p) => ({
    id: p.id,
    title: p.title,
    url: p.url,
    price: p.price,
    productType: p.productType,
    description: p.description?.slice(0, 200),
    images: p.images.slice(0, 4),
    isHero: heroType.has(p.id),
    typeName:
      heroType.get(p.id) ??
      byMember.get(p.id) ??
      byListedType.get(p.productType?.trim().toLowerCase() ?? "") ??
      // Fallback picks group by the listed type itself.
      (kit.productsPickedBy === "default" ? p.productType?.trim() || "Other" : "Other"),
  }));
}

function defaultPicks(products: Product[]): { types: ProductType[]; picks: SelectedProduct[] } {
  const groups = new Map<string, Product[]>();
  for (const p of products) {
    const type = p.productType?.trim() || "Other";
    groups.set(type, [...(groups.get(type) ?? []), p]);
  }
  const ranked = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, MAX_PRODUCT_TYPES);
  return {
    types: ranked.map(([name]) => ({ name })),
    picks: ranked.map(([name, items]) => {
      const best = [...items].sort((a, b) => b.images.length - a.images.length)[0];
      return { ...best, features: [], typeName: name };
    }),
  };
}

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

function strings(values: unknown): string[] {
  return Array.isArray(values)
    ? values.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
}
