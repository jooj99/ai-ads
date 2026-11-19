import "server-only";

import type Firecrawl from "@mendable/firecrawl-js";

import { adoptBrandName } from "@/lib/campaigns";

import {
  findSiteProducts,
  findSiteServices,
  photosForPicks,
  pickerCandidates,
  pickPhotoExclusions,
  pickSiteLinks,
  sharedPhotoCleanup,
} from "./catalog";
import { storeFontFiles } from "./font-store";
import {
  streamBrandInsights,
  streamCatalogGrouping,
  type BrandInsights,
  type CatalogGrouping,
} from "./insights";
import type { LinkPicks } from "./links";
import { classifyOffering as classifyOfferingCall } from "./offering";
import { researchPage, type PageResearch } from "./page";
import { detectShopify, fetchShopifyCatalog, type ShopifyStore } from "./shopify";
import type { CatalogEntry, ResearchSession } from "./state";
import { MAX_PRODUCT_TYPES, type Offering, type Product, type ProductType } from "./types";

/**
 * Research, one step at a time. Each step reads what earlier steps stored
 * (through the session), does one job, saves its result, and returns a
 * one-line summary. The agent calls these as tools in whatever order the
 * research skill and the user's direction call for; when a step's input is
 * missing it throws a `StepPrerequisiteError` saying which step to run first.
 *
 * Scraped facts (logo, colors, fonts, products, photos) go straight into
 * storage; the model only ever sees summaries and ids, and picks by id.
 */

export type StepContext = {
  session: ResearchSession;
  fc: Firecrawl | null;
  /** Live status for the step, e.g. "Reading 4 product pages". */
  progress?: (detail: string) => void;
};

export type StepResult = {
  /** True when the step did its job (possibly partly); false when it degraded to nothing. */
  ok: boolean;
  /** One line for the chat and the agent, e.g. "Found 233 products in the Shopify catalog". */
  summary: string;
  /** Small structured results (ids, counts, link lists) for the agent's next decision. */
  data?: Record<string, unknown>;
};

/** A step was called before the one it depends on; the message names the step to run first. */
export class StepPrerequisiteError extends Error {}

/** Hero items shown per product type. */
const MAX_ITEMS_PER_TYPE = 2;
/** Extra page reads for picks without photos (Firecrawl's free plan allows ~15/minute). */
const MAX_PHOTO_FETCHES = 4;
/** Partial model output arrives many times a second; apply it at most this often. */
const KIT_THROTTLE_MS = 150;

/** Titles of error pages, which are never products. */
const ERROR_TITLE = /^(404|403|500|page not found|not found|access denied|forbidden|error|oops)\b/i;

const SHOPIFY_KEY = "store";
const LINKS_KEY = "picks";

// --- reading -----------------------------------------------------------------

/** Detects a Shopify store (its /meta.json); Shopify stores expose their whole catalog. */
export async function detectPlatform({ session }: StepContext): Promise<StepResult> {
  const store = await detectShopify(new URL(session.kit.sourceUrl));
  await session.putSnapshot("shopify", SHOPIFY_KEY, store ?? { none: true });
  session.patchKit({ platform: store ? "shopify" : "website" });
  if (store?.name && !session.kit.name) session.patchKit({ name: store.name });
  await session.saveKit();
  return {
    ok: true,
    summary: store ? "Shopify store detected" : "Website (not a Shopify store)",
    data: { shopify: Boolean(store) },
  };
}

export type BrandField = "name" | "logo" | "colors" | "fonts";

/**
 * Reads a page of the site (the homepage by default): brand extractor, HTML
 * signals for gaps, navbar and footer, font files. The read is stored for
 * later steps. On the homepage (or when `fields` are given) the logo, colors,
 * fonts and name it found are applied to the kit, except edited ones.
 */
export async function readSite(
  { session, fc, progress }: StepContext,
  { url, fields }: { url?: string; fields?: BrandField[] } = {},
): Promise<StepResult> {
  const target = new URL(url ?? session.kit.sourceUrl);
  const home = sameUrl(target.href, session.kit.sourceUrl);
  progress?.(`Reading ${target.hostname}${target.pathname === "/" ? "" : target.pathname}`);
  const page = await researchPage(fc, target);
  if (!page) {
    return { ok: false, summary: `Couldn't load ${target.href}` };
  }
  await session.putSnapshot("page", target.href, page);

  const apply = new Set<BrandField>(fields ?? (home ? ["name", "logo", "colors", "fonts"] : []));
  if (apply.has("name") && page.siteName && !session.kit.name) session.patchKit({ name: page.siteName });
  if (apply.has("logo")) session.patchKit({ logo: page.logo, logoCandidates: page.logoCandidates });
  if (apply.has("colors") && page.colors.length) session.patchKit({ colors: page.colors });
  if (apply.has("fonts") && page.fonts.length && session.canWrite("fonts")) {
    progress?.("Copying the site's font files");
    session.patchKit({ fonts: await storeFontFiles(session.campaignId, page.fonts, session.kit.sourceUrl) });
  }
  if (apply.size) await session.saveKit();
  const kept = (["colors", "fonts", "logo"] as const).filter((f) => apply.has(f) && !session.canWrite(f));

  const logo = page.hasRealLogo
    ? `logo${page.logoVia && page.logoVia !== "brand extractor" ? ` (${page.logoVia})` : ""}`
    : page.logo
      ? "an icon only, no full logo"
      : "no logo";
  const found = `${logo}, ${page.colors.length} colors, ${page.fonts.length} fonts${
    kept.length ? ` (kept your edited ${kept.join(" and ")})` : ""
  }`;
  return {
    ok: true,
    summary: home
      ? page.source === "html"
        ? `Found ${found} from the page's HTML (brand extractor unavailable)`
        : page.filled.length
          ? `Found ${found}; filled gaps from the HTML: ${page.filled.join(", ")}`
          : `Found ${found}`
      : `Read “${page.title ?? target.pathname}”${apply.size ? `; applied ${[...apply].join(", ")}` : ""}`,
    data: {
      url: target.href,
      title: page.title,
      navigation: page.navigation.slice(0, 600),
      degraded: page.source === "html" || !page.hasRealLogo || page.colors.length === 0,
      ...(home ? {} : { content: pageText(page.content, 6_000) }),
    },
  };
}

// --- deciding what the business sells ------------------------------------------

/** Asks a small model whether the business sells goods or services (with optional direction). */
export async function classifyOffering(
  { session }: StepContext,
  { guidance }: { guidance?: string } = {},
): Promise<StepResult> {
  const page = await homepage(session);
  const store = await shopify(session);
  const { offering, reason } = await classifyOfferingCall({
    domain: session.kit.domain,
    page,
    isShopify: Boolean(store),
    guidance,
  });
  return setOffering({ session, fc: null }, { offering, reason });
}

/** Sets goods or services directly (the agent's or user's decision, or a classification). */
export async function setOffering(
  { session }: StepContext,
  { offering, reason }: { offering: Offering; reason: string },
): Promise<StepResult> {
  const changed = session.patchKit({ offering, offeringReason: reason });
  await session.saveKit();
  if (!changed.length) {
    return { ok: true, summary: `Kept ${session.kit.offering} (edited earlier)`, data: { offering: session.kit.offering } };
  }
  return { ok: true, summary: `Sells ${offering}: ${reason}`, data: { offering } };
}

// --- finding the catalog ---------------------------------------------------------

/** The homepage's same-site links (navbar, footer, body), for the agent to choose from. No model involved. */
export async function listSiteLinks({ session }: StepContext): Promise<StepResult> {
  const page = await homepage(session);
  const links = pickerCandidates(new URL(session.kit.sourceUrl), page).slice(0, 80);
  return {
    ok: true,
    summary: `${links.length} links on the homepage`,
    data: { links: links.map((l) => ({ url: l.url, text: l.text, area: l.area })) },
  };
}

/** A small model picks which links are offerings, offering indexes and audience pages. */
export async function findOfferingPages(
  { session }: StepContext,
  { guidance }: { guidance?: string } = {},
): Promise<StepResult> {
  const page = await homepage(session);
  const offering = requireOffering(session);
  const picks = await pickSiteLinks({ url: new URL(session.kit.sourceUrl), page, offering, guidance });
  if (!picks) {
    return { ok: false, summary: "Couldn't tell which pages list what they sell; loadCatalog will use keyword rules" };
  }
  await session.putSnapshot("links", LINKS_KEY, picks);
  const noun = offering === "services" ? "service" : "product";
  return {
    ok: true,
    summary: `Picked ${picks.offerings.length} ${noun} page${picks.offerings.length === 1 ? "" : "s"}${
      picks.indexes.length ? ` and ${picks.indexes.length} index page${picks.indexes.length === 1 ? "" : "s"}` : ""
    }`,
    data: {
      offerings: picks.offerings.map((l) => ({ url: l.url, text: l.text })),
      indexes: picks.indexes.map((l) => ({ url: l.url, text: l.text })),
      audience: picks.audience.map((l) => l.text).filter(Boolean),
    },
  };
}

/**
 * Loads products or services into the catalog: from the Shopify catalog, or
 * by reading the site's pages (the picked ones, or `urls`). "replace" swaps
 * out what research found before; "add" keeps it. Items the agent or user
 * added always stay.
 */
export async function loadCatalog(
  { session, fc, progress }: StepContext,
  { from, urls, mode = "replace" }: { from: "shopify" | "pages"; urls?: string[]; mode?: "add" | "replace" },
): Promise<StepResult> {
  const offering = requireOffering(session);
  const noun = offering === "services" ? "services" : "products";
  let items: Product[];

  if (from === "shopify") {
    const store = await shopify(session);
    if (!store) throw new StepPrerequisiteError("This isn't a Shopify store; load the catalog from its pages instead.");
    progress?.("Loading the Shopify catalog");
    items = (await fetchShopifyCatalog(store)).products;
  } else {
    if (!fc) return { ok: false, summary: `Can't read ${noun} pages: Firecrawl isn't configured` };
    const page = await homepage(session);
    const picked = urls?.length
      ? ({ offerings: urls.map((u) => ({ url: u, text: "" })), indexes: [], audience: [] } satisfies LinkPicks)
      : await session.getSnapshot<LinkPicks>("links", LINKS_KEY);
    progress?.(
      picked
        ? `Reading ${picked.offerings.length + picked.indexes.length} ${noun} pages`
        : `Looking for ${noun} pages`,
    );
    const url = new URL(session.kit.sourceUrl);
    if (offering === "services") {
      // A service business's Shopify shop is its retail side: its photos are
      // cross-sells on service pages, never a service's own photo.
      const store = await shopify(session);
      const retail = store ? await fetchShopifyCatalog(store).catch(() => null) : null;
      items = await findSiteServices(fc, url, page, retail?.products.flatMap((p) => p.images) ?? [], picked);
    } else {
      items = await findSiteProducts(fc, url, page, picked);
    }
  }

  // A page that failed to load can come back as an "item" named after the error.
  items = items.filter((i) => !ERROR_TITLE.test(i.title.trim()));
  const { added, removed } = session.mergeProducts(items, mode);
  if (from === "pages") {
    // Items keep photos from earlier reads when a new read finds none, so
    // re-apply the shared-photo rule across the whole merged catalog.
    const changed = sharedPhotoCleanup(session.catalog, await homepage(session).catch(() => null));
    if (changed.size) session.setPhotos(changed);
  }
  await Promise.all([session.saveCatalog(), session.saveKit()]);
  const withPhotos = items.filter((i) => i.images.length > 0).length;
  if (!items.length) {
    return { ok: false, summary: `No ${noun} found; they can be added by link`, data: { total: session.catalog.length } };
  }
  return {
    ok: true,
    summary:
      from === "shopify"
        ? `${items.length} ${noun} in the Shopify catalog`
        : `Found ${items.length} ${noun} (${withPhotos} with photos from the site)`,
    data: { found: items.length, added, removed, total: session.catalog.length },
  };
}

/** Removes items from the catalog (the agent's or user's decision). */
export async function removeProducts({ session }: StepContext, { ids }: { ids: string[] }): Promise<StepResult> {
  const removed = session.removeProducts(ids);
  await Promise.all([session.saveCatalog(), session.saveKit()]);
  return { ok: true, summary: `Removed ${removed} item${removed === 1 ? "" : "s"}`, data: { removed } };
}

// --- understanding the brand ---------------------------------------------------

/** Writes the name, tagline, value proposition, audience and voice (edited fields are kept). */
export async function writeBrandInsights(
  { session }: StepContext,
  { guidance }: { guidance?: string } = {},
): Promise<StepResult> {
  const page = await homepage(session);
  const offering = session.kit.offering ?? "goods";
  const links = await session.getSnapshot<LinkPicks>("links", LINKS_KEY);
  const result = streamBrandInsights({
    domain: session.kit.domain,
    page,
    products: session.catalog,
    offering,
    audiencePages: links?.audience.map((l) => l.text).filter(Boolean) ?? [],
    guidance,
  });
  let last = 0;
  for await (const partial of result.partialOutputStream) {
    if (Date.now() - last > KIT_THROTTLE_MS) {
      session.patchKit(brandPatch(partial as DeepPartial<BrandInsights>));
      last = Date.now();
    }
  }
  const final = await result.output;
  const changed = session.patchKit(brandPatch(final));
  await session.saveKit();
  if (session.kit.name) await adoptBrandName(session.campaignId, session.kit.name, session.kit.domain);
  const kept = ["valueProposition", "audience.segments", "voice.summary", "tagline"].filter(
    (f) => !changed.includes(f as never) && session.edited.has(f),
  );
  return {
    ok: true,
    summary: `Wrote the value proposition, audience and voice${kept.length ? ` (kept your edits to ${kept.join(", ")})` : ""}`,
  };
}

function brandPatch(b: DeepPartial<BrandInsights>) {
  return {
    name: b.brandName || undefined,
    tagline: b.tagline || undefined,
    valueProposition: b.valueProposition || undefined,
    audience: b.audience
      ? { summary: b.audience.summary || undefined, segments: b.audience.segments ? strings(b.audience.segments) : undefined }
      : undefined,
    voice: b.voice
      ? {
          summary: b.voice.summary || undefined,
          traits: b.voice.traits ? strings(b.voice.traits) : undefined,
          sampleLine: b.voice.sampleLine || undefined,
        }
      : undefined,
  };
}

// --- organizing the catalog -------------------------------------------------------

/**
 * Groups the whole catalog into at most 10 kinds of product or service and
 * picks 1–2 heroes each, following optional direction ("group cases by phone
 * model"). Kept as-is when the user or agent set the grouping themselves.
 */
export async function groupCatalog(
  { session }: StepContext,
  { guidance }: { guidance?: string } = {},
): Promise<StepResult> {
  if (!session.catalog.length) throw new StepPrerequisiteError("The catalog is empty: call loadCatalog first.");
  if (!session.canWrite("productTypes")) {
    return { ok: true, summary: "Kept the grouping you set (edited); set it again with setProductTypes" };
  }
  const offering = session.kit.offering ?? "goods";
  const noun = offering === "services" ? "service" : "product";
  const page = await homepage(session).catch(() => null);
  const products = session.catalog;
  const byId = new Map(products.map((p) => [p.id, p]));

  const apply = (grouping: DeepPartial<CatalogGrouping>, final: boolean) => {
    const types: ProductType[] = [];
    const heroes: { id: string; typeName: string; reason?: string; features?: string[] }[] = [];
    const used = new Set<string>();
    for (const type of grouping.productTypes ?? []) {
      const name = type?.name;
      if (!name || types.length >= MAX_PRODUCT_TYPES) continue;
      const picks = (type.items ?? []).flatMap((pick) => {
        const item = pick?.id ? byId.get(pick.id) : undefined;
        if (!item || used.has(item.id)) return []; // only real, unrepeated catalog items
        used.add(item.id);
        return [{ id: item.id, typeName: name, reason: pick?.reason, features: strings(pick?.features) }];
      });
      if (!picks.length) continue;
      types.push({ name, summary: type.summary });
      heroes.push(...picks.slice(0, MAX_ITEMS_PER_TYPE));
    }
    const typeOf = final ? membership(products, types, heroes, grouping as CatalogGrouping) : new Map<string, string>();
    session.setGrouping({ types, typeOf, heroes, pickedBy: "ai" });
  };

  try {
    const result = streamCatalogGrouping({ domain: session.kit.domain, page, products, offering, guidance });
    let last = 0;
    for await (const partial of result.partialOutputStream) {
      if (Date.now() - last > KIT_THROTTLE_MS) {
        apply(partial as DeepPartial<CatalogGrouping>, false);
        last = Date.now();
      }
    }
    apply(await result.output, true);
  } catch (error) {
    console.error("[research] catalog grouping failed", error);
    const fallback = defaultGrouping(products);
    session.setGrouping({ ...fallback, pickedBy: "default" });
    await Promise.all([session.saveCatalog(), session.saveKit()]);
    return {
      ok: false,
      summary: `Couldn't group the ${noun}s with the model; grouped them by their listed type instead`,
    };
  }

  await Promise.all([session.saveCatalog(), session.saveKit()]);
  const types = session.kit.productTypes.length;
  return {
    ok: session.kit.products.length > 0,
    summary: `Grouped ${products.length} ${noun}s into ${types} type${types === 1 ? "" : "s"}; picked ${session.kit.products.length} to feature`,
    data: { types: session.kit.productTypes.map((t) => t.name), heroIds: session.kit.products.map((p) => p.id) },
  };
}

/**
 * Sets the grouping directly (the agent's or user's decision): types with
 * their heroes and, optionally, members, by catalog id. Items not listed as
 * members keep their current type if it's still one of the types, otherwise
 * they become "Other". Unknown ids are ignored.
 */
export async function setProductTypes(
  { session }: StepContext,
  { types }: { types: { name: string; summary?: string; memberIds?: string[]; heroIds: string[] }[] },
): Promise<StepResult> {
  const known = new Map(session.catalog.map((e) => [e.id, e]));
  const names = new Set(types.slice(0, MAX_PRODUCT_TYPES).map((t) => t.name));
  const typeOf = new Map(
    session.catalog.map((e) => [e.id, e.typeName && names.has(e.typeName) ? e.typeName : "Other"]),
  );
  const heroes: { id: string; typeName: string; reason?: string; features?: string[] }[] = [];
  for (const type of types.slice(0, MAX_PRODUCT_TYPES)) {
    for (const id of type.memberIds ?? []) if (known.has(id)) typeOf.set(id, type.name);
    for (const id of type.heroIds) {
      const item = known.get(id);
      if (item) heroes.push({ id, typeName: type.name, reason: item.reason, features: item.features });
    }
  }
  const unknown = types.flatMap((t) => [...t.heroIds, ...(t.memberIds ?? [])]).filter((id) => !known.has(id));
  session.setGrouping({
    types: types.slice(0, MAX_PRODUCT_TYPES).map((t) => ({ name: t.name, summary: t.summary })),
    typeOf,
    heroes,
    pickedBy: "ai",
  });
  await Promise.all([session.saveCatalog(), session.saveKit()]);
  return {
    ok: true,
    summary: `Set ${types.length} type${types.length === 1 ? "" : "s"} with ${heroes.length} hero${heroes.length === 1 ? "" : "es"}${
      unknown.length ? ` (ignored ${unknown.length} unknown id${unknown.length === 1 ? "" : "s"})` : ""
    }`,
  };
}

/** Reads the pages of heroes (or `productIds`) that have no photo yet, for the site's own photos. */
export async function findPhotos(
  { session, fc, progress }: StepContext,
  { productIds }: { productIds?: string[] } = {},
): Promise<StepResult> {
  if (!fc) return { ok: false, summary: "Can't read pages for photos: Firecrawl isn't configured" };
  const wanted = productIds?.length ? new Set(productIds) : null;
  // A page shared by several items (the homepage, a pricing page) is about
  // all of them; its pictures are no single item's photo.
  const itemsPerUrl = new Map<string, number>();
  for (const e of session.catalog) itemsPerUrl.set(e.url, (itemsPerUrl.get(e.url) ?? 0) + 1);
  const targets = session.catalog
    .filter((e) => (wanted ? wanted.has(e.id) : e.isHero && e.images.length === 0))
    .filter(
      (e) =>
        !e.url.includes("#") && !sameUrl(e.url, session.kit.sourceUrl) && (itemsPerUrl.get(e.url) ?? 0) < 2,
    )
    .slice(0, MAX_PHOTO_FETCHES);
  if (!targets.length) return { ok: true, summary: "Every pick already has a photo" };

  progress?.(`Getting photos for ${targets.length} item${targets.length === 1 ? "" : "s"}`);
  const store = await shopify(session).catch(() => null);
  const retail = store ? ((await fetchShopifyCatalog(store).catch(() => null))?.products.flatMap((p) => p.images) ?? []) : [];
  const page = await homepage(session).catch(() => null);
  const waiting = new Set(targets.map((t) => t.id));
  const photos = await photosForPicks(
    fc,
    targets,
    retail,
    pickPhotoExclusions(page, session.catalog.filter((e) => !waiting.has(e.id))),
  );
  // Photos are per page; give them only to the item that page is about.
  const byId = new Map(targets.filter((t) => photos.has(t.url)).map((t) => [t.id, photos.get(t.url)!]));
  session.setPhotos(byId);
  await Promise.all([session.saveCatalog(), session.saveKit()]);
  return {
    ok: photos.size > 0,
    summary: `Found photos for ${photos.size} of ${targets.length} item${targets.length === 1 ? "" : "s"}`,
  };
}

// --- reading state --------------------------------------------------------------

/** A compact view of the catalog for the agent: ids, titles, types and photo counts. */
export function getCatalog(
  { session }: StepContext,
  { typeName, query, limit = 60 }: { typeName?: string; query?: string; limit?: number } = {},
): StepResult {
  const q = query?.toLowerCase();
  const items = session.catalog
    .filter((e) => !typeName || e.typeName === typeName)
    .filter((e) => !q || `${e.title} ${e.productType ?? ""} ${(e.tags ?? []).join(" ")}`.toLowerCase().includes(q))
    .slice(0, Math.min(limit, 200));
  return {
    ok: true,
    summary: `${items.length} of ${session.catalog.length} items`,
    data: {
      items: items.map((e) => ({
        id: e.id,
        title: e.title,
        listedType: e.productType,
        type: e.typeName,
        hero: Boolean(e.isHero),
        price: e.price,
        photos: e.images.length,
        origin: e.origin,
      })),
    },
  };
}

/** What research has done and what's missing, item by item (the skill's checklist). */
export async function researchStatus({ session }: StepContext): Promise<StepResult> {
  const kit = session.kit;
  const [store, page] = await Promise.all([
    session.getSnapshot<ShopifyStore | { none: true }>("shopify", SHOPIFY_KEY),
    session.getSnapshot<PageResearch>("page", kit.sourceUrl),
  ]);
  const heroesWithoutPhotos = session.catalog.filter((e) => e.isHero && e.images.length === 0).length;
  const checklist = {
    platform: store ? "done" : "missing: call detectPlatform",
    homepage: page ? "done" : "missing: call readSite",
    brand: kit.logo && kit.colors.length && kit.fonts.length ? "done" : "partial: logo, colors or fonts not found",
    offering: kit.offering ? `done (${kit.offering})` : "missing: call classifyOffering or setOffering",
    catalog: session.catalog.length ? `done (${session.catalog.length} items)` : "missing: call loadCatalog",
    insights:
      kit.valueProposition && kit.audience?.segments?.length && kit.voice?.summary
        ? "done"
        : "missing: call writeBrandInsights",
    grouping: kit.productTypes.length
      ? `done (${kit.productTypes.length} types, ${kit.products.length} heroes)`
      : session.catalog.length
        ? "missing: call groupCatalog"
        : "waiting for the catalog",
    photos: heroesWithoutPhotos ? `${heroesWithoutPhotos} hero(es) without photos: call findPhotos` : "done",
  };
  const missing = Object.entries(checklist)
    .filter(([, v]) => v.startsWith("missing"))
    .map(([k]) => k);
  return {
    ok: missing.length === 0,
    summary: missing.length ? `Still to do: ${missing.join(", ")}` : "Research is complete",
    data: { checklist, edited: [...session.edited] },
  };
}

// --- helpers ---------------------------------------------------------------------

/**
 * A page's own copy for the agent: the read includes the navbar and footer
 * (link lists), which would otherwise fill the excerpt, so lines that are
 * mostly links or images are dropped first.
 */
function pageText(markdown: string, maxChars: number): string {
  return markdown
    .split("\n")
    .filter((line) => {
      const text = line.trim();
      if (!text) return false;
      const markup = (text.match(/!?\[[^\]]*\]\([^)]*\)/g) ?? []).join("").length;
      return markup / text.length < 0.6;
    })
    .join("\n")
    .slice(0, maxChars);
}

async function homepage(session: ResearchSession): Promise<PageResearch> {
  const page = await session.getSnapshot<PageResearch>("page", session.kit.sourceUrl);
  if (!page) throw new StepPrerequisiteError("The homepage hasn't been read: call readSite first.");
  return page;
}

async function shopify(session: ResearchSession): Promise<ShopifyStore | null> {
  const store = await session.getSnapshot<ShopifyStore | { none: true }>("shopify", SHOPIFY_KEY);
  if (!store) throw new StepPrerequisiteError("The platform isn't known: call detectPlatform first.");
  return "none" in store ? null : store;
}

function requireOffering(session: ResearchSession): Offering {
  if (!session.kit.offering) {
    throw new StepPrerequisiteError("Goods or services isn't decided: call classifyOffering or setOffering first.");
  }
  return session.kit.offering;
}

function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, "")}${x.pathname.replace(/\/$/, "")}`;
  };
  return norm(a) === norm(b);
}

/**
 * Which type each item belongs to: heroes keep their pick's type, then the
 * model's member ids (small catalogs), then the item's listed type mapped
 * through the model's `catalogTypes`; anything left is "Other".
 */
function membership(
  products: CatalogEntry[],
  types: ProductType[],
  heroes: { id: string; typeName: string }[],
  grouping: CatalogGrouping,
): Map<string, string> {
  const known = new Set(types.map((t) => t.name));
  const heroType = new Map(heroes.map((h) => [h.id, h.typeName]));
  const byMember = new Map<string, string>();
  const byListed = new Map<string, string>();
  for (const type of grouping.productTypes) {
    if (!known.has(type.name)) continue;
    for (const id of type.memberIds) if (!byMember.has(id)) byMember.set(id, type.name);
    for (const listed of type.catalogTypes) {
      const key = listed.trim().toLowerCase();
      if (!byListed.has(key)) byListed.set(key, type.name);
    }
  }
  return new Map(
    products.map((p) => [
      p.id,
      heroType.get(p.id) ?? byMember.get(p.id) ?? byListed.get(p.productType?.trim().toLowerCase() ?? "") ?? "Other",
    ]),
  );
}

/**
 * Used only when the model is unavailable: group by the catalog's own type
 * field (largest first, at most 10) and pick the item with the most photos.
 */
function defaultGrouping(products: CatalogEntry[]) {
  const groups = new Map<string, CatalogEntry[]>();
  for (const p of products) {
    const type = p.productType?.trim() || "Other";
    groups.set(type, [...(groups.get(type) ?? []), p]);
  }
  const ranked = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, MAX_PRODUCT_TYPES);
  const typeOf = new Map(products.map((p) => [p.id, p.productType?.trim() || "Other"]));
  return {
    types: ranked.map(([name]) => ({ name })),
    typeOf,
    heroes: ranked.map(([name, items]) => {
      const best = [...items].sort((a, b) => b.images.length - a.images.length)[0];
      return { id: best.id, typeName: name, features: [] };
    }),
  };
}

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

function strings(values: unknown): string[] {
  return Array.isArray(values)
    ? values.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
}
