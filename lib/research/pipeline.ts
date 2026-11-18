import { streamInsights, type Insights } from "./insights";
import {
  findSiteProducts,
  firecrawlClient,
  scrapeWithFetch,
  scrapeWithFirecrawl,
  type PageResearch,
} from "./page";
import { detectShopify, fetchShopifyCatalog } from "./shopify";
import {
  STEP_LABELS,
  STEP_ORDER,
  type BrandKit,
  type Product,
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

/**
 * URL → brand kit. Store detection, the homepage read and the catalog load
 * run in parallel and stream their results as soon as each lands; the model
 * then reads everything once to infer value prop, audience and voice and to
 * pick products. Each step degrades on its own, so one failing source never
 * blanks the whole kit.
 */
export async function runResearch(input: string, emit: ResearchEmitter): Promise<void> {
  const setStep = (id: StepId, status: StepStatus, detail?: string) =>
    emit.step({ id, label: STEP_LABELS[id], status, detail });

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
    products: [],
  };
  const sendKit = () => emit.kit(structuredClone(kit));

  for (const id of STEP_ORDER) setStep(id, id === "insights" ? "pending" : "running");
  sendKit();

  const fc = firecrawlClient();

  // 1. Platform detection decides how products are loaded.
  const shopifyPromise = detectShopify(url);

  // 2. Homepage: Firecrawl's brand extractor, falling back to reading the HTML ourselves.
  const pagePromise: Promise<PageResearch | null> = (async () => {
    if (fc) {
      try {
        return await scrapeWithFirecrawl(fc, url);
      } catch (error) {
        console.error("[research] firecrawl scrape failed", error);
      }
    }
    try {
      return await scrapeWithFetch(url);
    } catch (error) {
      console.error("[research] html fallback failed", error);
      return null;
    }
  })();

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

    const found = [
      page.logo ? "logo" : null,
      `${page.colors.length} colors`,
      `${page.fonts.length} fonts`,
    ]
      .filter(Boolean)
      .join(", ");
    const degraded = page.source === "html" || !page.logo || page.colors.length === 0;
    setStep(
      "brand",
      degraded ? "warning" : "done",
      page.source === "html"
        ? `Found ${found} from the page markup (brand extractor unavailable)`
        : `Found ${found}`,
    );
    return page;
  });

  const catalogStep: Promise<Product[]> = (async () => {
    const shopify = await shopifyPromise;
    kit.platform = shopify ? "shopify" : "website";
    if (shopify?.name) kit.name ??= shopify.name;
    sendKit();
    setStep("detect", "done", shopify ? "Shopify store detected" : "Website (not a Shopify store)");

    try {
      if (shopify) {
        const { products, total } = await fetchShopifyCatalog(shopify);
        kit.catalogSize = total;
        sendKit();
        setStep("catalog", "done", `${total} products in the catalog`);
        return products;
      }

      const page = await pagePromise;
      if (!fc || !page) {
        setStep("catalog", "warning", "Couldn't look for product pages on this site");
        return [];
      }
      const products = await findSiteProducts(fc, url, page.links);
      kit.catalogSize = products.length;
      sendKit();
      setStep(
        "catalog",
        products.length ? "done" : "warning",
        products.length
          ? `Read ${products.length} product pages`
          : "No product pages found; you can add products by link later",
      );
      return products;
    } catch (error) {
      console.error("[research] catalog failed", error);
      setStep("catalog", "warning", "Couldn't load the product catalog");
      return [];
    }
  })();

  const [page, products] = await Promise.all([brandStep, catalogStep]);

  if (!page && products.length === 0) {
    setStep("insights", "error", "Nothing to analyze");
    emit.notice({
      level: "error",
      message: `We couldn't read ${kit.domain}. Check the address, or try again in a minute.`,
    });
    return;
  }

  // 3. The model reads everything once: value prop, audience, voice, product picks.
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
    kit.products = (insights.products ?? []).flatMap((pick): SelectedProduct[] => {
      const product = pick?.id ? byId.get(pick.id) : undefined;
      if (!product) return []; // drop anything not in the real catalog
      return [{ ...product, reason: pick?.reason, features: strings(pick?.features) }];
    });
    if (kit.products.length) kit.productsPickedBy = "ai";
  };

  try {
    const result = streamInsights({ domain: kit.domain, page, products });
    let lastSent = 0;
    for await (const partial of result.partialOutputStream) {
      applyInsights(partial as DeepPartial<Insights>);
      if (Date.now() - lastSent > KIT_THROTTLE_MS) {
        sendKit();
        lastSent = Date.now();
      }
    }
    applyInsights(await result.output);
    sendKit();

    const picked = kit.products.length;
    setStep(
      "insights",
      picked || products.length === 0 ? "done" : "warning",
      products.length === 0
        ? "Brand analyzed (no products to pick from)"
        : `Picked ${picked} product${picked === 1 ? "" : "s"} to feature`,
    );
  } catch (error) {
    console.error("[research] insights failed", error);
    setStep("insights", "error", "The brand analysis failed");
    if (kit.products.length === 0 && products.length > 0) {
      kit.products = defaultPicks(products);
      kit.productsPickedBy = "default";
      sendKit();
    }
    emit.notice({
      level: "warning",
      message:
        products.length > 0
          ? "We pulled the logo, colors, fonts and products, but couldn't write the value proposition, audience and voice, so products are a default pick. Try again."
          : "We pulled the logo, colors and fonts, but couldn't write the value proposition, audience and voice. Try again.",
    });
  }
}

/**
 * Used only when the model is unavailable: the first products with the most
 * photography, one per product type where possible, so ads still have variety.
 */
function defaultPicks(products: Product[], count = 4): SelectedProduct[] {
  const ranked = [...products].sort((a, b) => b.images.length - a.images.length);
  const picks: Product[] = [];
  const types = new Set<string | undefined>();
  for (const p of ranked) {
    if (picks.length >= count) break;
    if (!types.has(p.productType)) {
      picks.push(p);
      types.add(p.productType);
    }
  }
  for (const p of ranked) {
    if (picks.length >= count) break;
    if (!picks.includes(p)) picks.push(p);
  }
  return picks.map((p) => ({ ...p, features: [] }));
}

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

function strings(values: unknown): string[] {
  return Array.isArray(values)
    ? values.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
}
